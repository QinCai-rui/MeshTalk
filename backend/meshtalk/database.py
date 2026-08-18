"""SQLite persistence layer.

Stores: identity, peers, messages, outgoing queue, seen message IDs.
"""

from __future__ import annotations

import time
import os
from pathlib import Path

import aiosqlite
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCHEMA = """
CREATE TABLE IF NOT EXISTS peers (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT 'Anonymous',
    public_key BLOB,
    signing_public_key BLOB,
    last_seen REAL,
    is_online INTEGER NOT NULL DEFAULT 0,
    tui_active INTEGER NOT NULL DEFAULT 0
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
    queued INTEGER NOT NULL DEFAULT 0,
    read_at REAL
);

CREATE TABLE IF NOT EXISTS outgoing_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    recipient_id TEXT NOT NULL,
    packet_type INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS friends (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_requests (
    request_id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    recipient_id TEXT NOT NULL DEFAULT '',
    recipient_name TEXT NOT NULL DEFAULT '',
    note TEXT,
    created_at REAL NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    responded_at REAL
);

CREATE TABLE IF NOT EXISTS blocked_peers (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


class Database:
    def __init__(self, db_path: Path, storage_key: bytes | None = None) -> None:
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None
        self._cipher = AESGCM(storage_key or os.urandom(32))

    async def connect(self) -> None:
        self._db = await aiosqlite.connect(str(self.db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(peers)")}
        if "signing_public_key" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN signing_public_key BLOB")
        if "tui_active" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN tui_active INTEGER NOT NULL DEFAULT 0")
        if "lan_endpoint" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN lan_endpoint TEXT")
        if "remote_endpoint" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN remote_endpoint TEXT")
        message_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(messages)")}
        if "read_at" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN read_at REAL")
        if "blocked" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")
        if "queued" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN queued INTEGER NOT NULL DEFAULT 0")
        queue_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(outgoing_queue)")}
        if "packet_type" not in queue_columns:
            await self._db.execute("ALTER TABLE outgoing_queue ADD COLUMN packet_type INTEGER NOT NULL DEFAULT 0")
        friend_request_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(friend_requests)")}
        if "recipient_id" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_id TEXT NOT NULL DEFAULT ''")
        if "recipient_name" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_name TEXT NOT NULL DEFAULT ''")
        await self._encrypt_existing_message_content()
        await self._db.commit()

    def _encrypt_content(self, content: str) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._cipher.encrypt(nonce, content.encode(), None)

    def _decrypt_content(self, content: bytes | str | None) -> str | None:
        if content is None:
            return None
        if isinstance(content, str):
            # Existing plaintext rows are migrated during connect().
            return content
        return self._cipher.decrypt(content[:12], content[12:], None).decode()

    async def _encrypt_existing_message_content(self) -> None:
        async with self._db.execute("SELECT message_id, content FROM messages WHERE content IS NOT NULL") as cursor:
            rows = [row async for row in cursor]
        for row in rows:
            if isinstance(row["content"], str):
                await self._db.execute(
                    "UPDATE messages SET content = ? WHERE message_id = ?",
                    (self._encrypt_content(row["content"]), row["message_id"]),
                )

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
        self, peer_id: str, display_name: str, public_key: bytes, signing_public_key: bytes, tui_active: bool = False
    ) -> None:
        await self._db.execute(
            """INSERT INTO peers (peer_id, display_name, public_key, signing_public_key, last_seen, is_online, tui_active)
               VALUES (?, ?, ?, ?, ?, 1, ?)
               ON CONFLICT(peer_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 public_key = excluded.public_key,
                 signing_public_key = excluded.signing_public_key,
                 last_seen = excluded.last_seen,
                  is_online = 1,
                  tui_active = excluded.tui_active""",
            (peer_id, display_name, public_key, signing_public_key, time.time(), int(tui_active)),
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

    async def save_peer_endpoint(self, peer_id: str, transport: str, endpoint: tuple[str, int] | None) -> None:
        column = "lan_endpoint" if transport == "lan_tcp" else "remote_endpoint"
        value = f"{endpoint[0]}:{endpoint[1]}" if endpoint else None
        await self._db.execute(
            f"UPDATE peers SET {column} = ? WHERE peer_id = ?", (value, peer_id)
        )
        await self._db.commit()

    async def load_peer_endpoints(self) -> dict[str, dict[str, tuple[str, int]]]:
        result: dict[str, dict[str, tuple[str, int]]] = {}
        async with self._db.execute(
            "SELECT peer_id, lan_endpoint, remote_endpoint FROM peers WHERE lan_endpoint IS NOT NULL OR remote_endpoint IS NOT NULL"
        ) as cursor:
            async for row in cursor:
                peer_id = row["peer_id"]
                endpoints: dict[str, tuple[str, int]] = {}
                for transport, column in [("lan_tcp", "lan_endpoint"), ("remote_udp", "remote_endpoint")]:
                    raw = row[column]
                    if raw and isinstance(raw, str) and ":" in raw:
                        host, _, port = raw.rpartition(":")
                        try:
                            endpoints[transport] = (host, int(port))
                        except ValueError:
                            pass
                if endpoints:
                    result[peer_id] = endpoints
        return result

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
            """SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued
               FROM (
                   SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued
                   FROM messages
                   WHERE (sender_id = ? AND recipient_id = ?)
                      OR (sender_id = ? AND recipient_id = ?)
                   ORDER BY created_at DESC
                   LIMIT ?
               )
               ORDER BY created_at ASC""",
            (local_peer_id, remote_peer_id, remote_peer_id, local_peer_id, limit),
        ) as cursor:
            messages = [dict(row) async for row in cursor]
        for message in messages:
            message["content"] = self._decrypt_content(message["content"])
            if isinstance(message["content"], bytes):
                message["content"] = message["content"].decode("utf-8", errors="replace")
        return messages

    async def save_message(self, msg: dict) -> None:
        await self._db.execute(
            """INSERT OR IGNORE INTO messages
                (message_id, sender_id, recipient_id, content, encrypted_content,
                 created_at, expires_at, hop_count, max_hops, read_at, blocked, queued)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg["message_id"],
                msg["sender_id"],
                msg["recipient_id"],
                self._encrypt_content(msg["content"]) if msg.get("content") is not None else None,
                msg["encrypted_content"],
                msg["created_at"],
                msg["expires_at"],
                msg["hop_count"],
                msg["max_hops"],
                msg.get("read_at"),
                msg.get("blocked", 0),
                msg.get("queued", 0),
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
        self,
        recipient_id: str,
        packet_type: int,
        encrypted_payload: bytes,
        message_id: str | None = None,
    ) -> None:
        await self._db.execute(
            """INSERT INTO outgoing_queue
               (message_id, recipient_id, packet_type, encrypted_payload, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (message_id, recipient_id, packet_type, encrypted_payload, time.time()),
        )
        await self._db.commit()

    async def get_pending_outgoing(self, recipient_id: str | None = None) -> list[dict]:
        if recipient_id is None:
            query = "SELECT * FROM outgoing_queue WHERE attempts < 5"
            params: tuple = ()
        else:
            query = "SELECT * FROM outgoing_queue WHERE recipient_id = ? AND attempts < 5"
            params = (recipient_id,)
        async with self._db.execute(query, params) as cursor:
            return [dict(row) async for row in cursor]

    async def increment_outqueue_attempts(self, queue_id: int) -> None:
        await self._db.execute(
            "UPDATE outgoing_queue SET attempts = attempts + 1, last_attempt = ? WHERE id = ?",
            (time.time(), queue_id),
        )
        await self._db.commit()

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
            "UPDATE messages SET delivered = 1, queued = 0 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def mark_message_sent(self, message_id: str) -> None:
        await self._db.execute(
            "UPDATE messages SET queued = 0 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def mark_message_blocked(self, message_id: str) -> None:
        await self._db.execute(
            "UPDATE messages SET blocked = 1 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def add_friend(self, peer_id: str, display_name: str) -> None:
        await self._db.execute(
            """INSERT INTO friends (peer_id, display_name, created_at) VALUES (?, ?, ?)
               ON CONFLICT(peer_id) DO UPDATE SET display_name = excluded.display_name""",
            (peer_id, display_name, time.time()),
        )
        await self._db.commit()

    async def remove_friend(self, peer_id: str) -> None:
        await self._db.execute("DELETE FROM friends WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def is_friend(self, peer_id: str) -> bool:
        async with self._db.execute(
            "SELECT 1 FROM friends WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def get_friends(self) -> list[dict]:
        async with self._db.execute(
            "SELECT peer_id, display_name, created_at FROM friends ORDER BY display_name"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def save_friend_request(self, request: dict) -> None:
        await self._db.execute(
            """INSERT OR IGNORE INTO friend_requests
               (request_id, sender_id, sender_name, recipient_id, recipient_name, note, created_at, direction, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                request["request_id"],
                request["sender_id"],
                request["sender_name"],
                request.get("recipient_id", ""),
                request.get("recipient_name", ""),
                request.get("note"),
                request["created_at"],
                request["direction"],
                request["status"],
            ),
        )
        await self._db.commit()

    async def get_friend_request(self, request_id: str) -> dict | None:
        async with self._db.execute(
            "SELECT * FROM friend_requests WHERE request_id = ?", (request_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_pending_friend_requests(self) -> list[dict]:
        async with self._db.execute(
            "SELECT * FROM friend_requests WHERE status = 'pending' ORDER BY created_at DESC"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def get_pending_request_with(self, peer_id: str, direction: str) -> dict | None:
        column = "sender_id" if direction == "incoming" else "recipient_id"
        async with self._db.execute(
            f"""SELECT * FROM friend_requests
                WHERE status = 'pending' AND direction = ? AND {column} = ? LIMIT 1""",
            (direction, peer_id),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def update_friend_request_status(self, request_id: str, status: str) -> None:
        await self._db.execute(
            "UPDATE friend_requests SET status = ?, responded_at = ? WHERE request_id = ?",
            (status, time.time(), request_id),
        )
        await self._db.commit()

    async def decline_pending_requests_with(self, peer_id: str) -> None:
        await self._db.execute(
            """UPDATE friend_requests SET status = 'declined', responded_at = ?
               WHERE status = 'pending' AND (sender_id = ? OR recipient_id = ?)""",
            (time.time(), peer_id, peer_id),
        )
        await self._db.commit()

    async def cancel_friend_request(self, request_id: str) -> None:
        await self._db.execute(
            "UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE request_id = ?",
            (time.time(), request_id),
        )
        await self._db.commit()

    async def cancel_incoming_requests_with(self, peer_id: str) -> None:
        await self._db.execute(
            """UPDATE friend_requests SET status = 'cancelled', responded_at = ?
               WHERE status = 'pending' AND direction = 'incoming' AND sender_id = ?""",
            (time.time(), peer_id),
        )
        await self._db.commit()

    async def block_peer(self, peer_id: str, display_name: str) -> None:
        await self._db.execute(
            """INSERT INTO blocked_peers (peer_id, display_name, created_at) VALUES (?, ?, ?)
               ON CONFLICT(peer_id) DO UPDATE SET display_name = excluded.display_name""",
            (peer_id, display_name, time.time()),
        )
        await self._db.commit()

    async def unblock_peer(self, peer_id: str) -> None:
        await self._db.execute("DELETE FROM blocked_peers WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def is_peer_blocked(self, peer_id: str) -> bool:
        async with self._db.execute(
            "SELECT 1 FROM blocked_peers WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def get_blocked_peers(self) -> list[dict]:
        async with self._db.execute(
            "SELECT peer_id, display_name, created_at FROM blocked_peers ORDER BY display_name"
        ) as cursor:
            return [dict(row) async for row in cursor]
