"""SQLite persistence layer.

Stores: identity, peers, messages, outgoing queue, seen message IDs.
"""

from __future__ import annotations

import time
from pathlib import Path

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS peers (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT 'Anonymous',
    public_key BLOB,
    signing_public_key BLOB,
    last_seen REAL,
    is_online INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    content TEXT,
    encrypted_content BLOB,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    hop_count INTEGER NOT NULL DEFAULT 0,
    max_hops INTEGER NOT NULL DEFAULT 10,
    delivered INTEGER NOT NULL DEFAULT 0,
    stored INTEGER NOT NULL DEFAULT 0,
    read_at REAL
);

CREATE TABLE IF NOT EXISTS outgoing_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    created_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt REAL
);

CREATE TABLE IF NOT EXISTS seen_messages (
    message_id TEXT PRIMARY KEY,
    seen_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Database:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._db = await aiosqlite.connect(str(self.db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(peers)")}
        if "signing_public_key" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN signing_public_key BLOB")
        message_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(messages)")}
        if "read_at" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN read_at REAL")
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    async def get_peer(self, peer_id: str) -> dict | None:
        async with self._db.execute(
            "SELECT * FROM peers WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def upsert_peer(
        self, peer_id: str, display_name: str, public_key: bytes, signing_public_key: bytes
    ) -> None:
        await self._db.execute(
            """INSERT INTO peers (peer_id, display_name, public_key, signing_public_key, last_seen, is_online)
               VALUES (?, ?, ?, ?, ?, 1)
               ON CONFLICT(peer_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 public_key = excluded.public_key,
                 signing_public_key = excluded.signing_public_key,
                 last_seen = excluded.last_seen,
                 is_online = 1""",
            (peer_id, display_name, public_key, signing_public_key, time.time()),
        )
        await self._db.commit()

    async def set_peer_online(self, peer_id: str, online: bool) -> None:
        await self._db.execute(
            "UPDATE peers SET is_online = ?, last_seen = ? WHERE peer_id = ?",
            (1 if online else 0, time.time(), peer_id),
        )
        await self._db.commit()

    async def get_online_peers(self) -> list[dict]:
        async with self._db.execute(
            "SELECT * FROM peers WHERE is_online = 1"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def get_all_peers(self) -> list[dict]:
        async with self._db.execute("SELECT * FROM peers") as cursor:
            return [dict(row) async for row in cursor]

    async def remove_peer(self, peer_id: str) -> None:
        await self._db.execute("DELETE FROM peers WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def get_unread_counts(self, local_peer_id: str) -> dict[str, int]:
        async with self._db.execute(
            """SELECT sender_id, COUNT(*) AS unread_count
               FROM messages
               WHERE recipient_id = ? AND read_at IS NULL
               GROUP BY sender_id""",
            (local_peer_id,),
        ) as cursor:
            return {row["sender_id"]: row["unread_count"] async for row in cursor}

    async def get_conversation(
        self, local_peer_id: str, remote_peer_id: str, limit: int = 200
    ) -> list[dict]:
        """Return the latest direct messages with one peer in chronological order."""
        async with self._db.execute(
            """SELECT message_id, sender_id, recipient_id, content, created_at, delivered
               FROM (
                   SELECT message_id, sender_id, recipient_id, content, created_at, delivered
                   FROM messages
                   WHERE (sender_id = ? AND recipient_id = ?)
                      OR (sender_id = ? AND recipient_id = ?)
                   ORDER BY created_at DESC
                   LIMIT ?
               )
               ORDER BY created_at ASC""",
            (local_peer_id, remote_peer_id, remote_peer_id, local_peer_id, limit),
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def save_message(self, msg: dict) -> None:
        await self._db.execute(
            """INSERT OR IGNORE INTO messages
                (message_id, sender_id, recipient_id, content, encrypted_content,
                 created_at, expires_at, hop_count, max_hops, read_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg["message_id"],
                msg["sender_id"],
                msg["recipient_id"],
                msg.get("content"),
                msg["encrypted_content"],
                msg["created_at"],
                msg["expires_at"],
                msg["hop_count"],
                msg["max_hops"],
                msg.get("read_at"),
            ),
        )
        await self._db.commit()

    async def mark_conversation_read(self, local_peer_id: str, remote_peer_id: str) -> None:
        await self._db.execute(
            """UPDATE messages SET read_at = ?
               WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL""",
            (time.time(), remote_peer_id, local_peer_id),
        )
        await self._db.commit()

    async def is_message_seen(self, message_id: str) -> bool:
        async with self._db.execute(
            "SELECT 1 FROM seen_messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def mark_message_seen(self, message_id: str) -> None:
        await self._db.execute(
            "INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?, ?)",
            (message_id, time.time()),
        )
        await self._db.commit()

    async def cleanup_expired(self) -> None:
        now = time.time()
        await self._db.execute(
            "DELETE FROM messages WHERE expires_at < ?", (now,)
        )
        await self._db.execute(
            "DELETE FROM seen_messages WHERE seen_at < ?", (now - 86400,)
        )
        await self._db.commit()

    async def add_to_outqueue(
        self, message_id: str, recipient_id: str, encrypted_payload: bytes
    ) -> None:
        await self._db.execute(
            """INSERT INTO outgoing_queue
               (message_id, recipient_id, encrypted_payload, created_at)
               VALUES (?, ?, ?, ?)""",
            (message_id, recipient_id, encrypted_payload, time.time()),
        )
        await self._db.commit()

    async def get_pending_outgoing(self) -> list[dict]:
        async with self._db.execute(
            "SELECT * FROM outgoing_queue WHERE attempts < 5"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def remove_from_outqueue(self, queue_id: int) -> None:
        await self._db.execute(
            "DELETE FROM outgoing_queue WHERE id = ?", (queue_id,)
        )
        await self._db.commit()

    async def get_stored_messages_for(self, peer_id: str) -> list[dict]:
        async with self._db.execute(
            """SELECT * FROM messages
               WHERE recipient_id = ? AND stored = 1 AND expires_at > ?""",
            (peer_id, time.time()),
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def mark_message_delivered(self, message_id: str) -> None:
        await self._db.execute(
            "UPDATE messages SET delivered = 1 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()
