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

CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (group_id, peer_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
    message_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content BLOB NOT NULL,
    created_at REAL NOT NULL,
    epoch INTEGER NOT NULL,
    read_at REAL
);

CREATE TABLE IF NOT EXISTS group_pending_rekeys (
    group_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    payload BLOB NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (group_id, peer_id, epoch)
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
        friend_request_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(friend_requests)")}
        if "recipient_id" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_id TEXT NOT NULL DEFAULT ''")
        if "recipient_name" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_name TEXT NOT NULL DEFAULT ''")
        group_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(groups)")}
        if "name" not in group_columns:
            await self._db.execute("ALTER TABLE groups ADD COLUMN name TEXT NOT NULL DEFAULT ''")
        if "owner_id" not in group_columns:
            await self._db.execute("ALTER TABLE groups ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
        if "epoch" not in group_columns:
            await self._db.execute("ALTER TABLE groups ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1")
        if "created_at" not in group_columns:
            await self._db.execute("ALTER TABLE groups ADD COLUMN created_at REAL NOT NULL DEFAULT 0")
        if "updated_at" not in group_columns:
            await self._db.execute("ALTER TABLE groups ADD COLUMN updated_at REAL NOT NULL DEFAULT 0")
        group_member_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_members)")}
        if "display_name" not in group_member_columns:
            await self._db.execute("ALTER TABLE group_members ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
        if "epoch" not in group_member_columns:
            await self._db.execute("ALTER TABLE group_members ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1")
        if "active" not in group_member_columns:
            await self._db.execute("ALTER TABLE group_members ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
        group_message_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_messages)")}
        if "sender_name" not in group_message_columns:
            await self._db.execute("ALTER TABLE group_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT ''")
        if "content" not in group_message_columns:
            await self._db.execute("ALTER TABLE group_messages ADD COLUMN content BLOB")
        if "epoch" not in group_message_columns:
            await self._db.execute("ALTER TABLE group_messages ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1")
        if "read_at" not in group_message_columns:
            await self._db.execute("ALTER TABLE group_messages ADD COLUMN read_at REAL")
        group_rekey_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_pending_rekeys)")}
        if "epoch" not in group_rekey_columns:
            await self._db.execute("ALTER TABLE group_pending_rekeys ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1")
        if "payload" not in group_rekey_columns:
            await self._db.execute("ALTER TABLE group_pending_rekeys ADD COLUMN payload BLOB")
        if "created_at" not in group_rekey_columns:
            await self._db.execute("ALTER TABLE group_pending_rekeys ADD COLUMN created_at REAL NOT NULL DEFAULT 0")
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

    def encrypt_blob(self, value: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._cipher.encrypt(nonce, value, None)

    def decrypt_blob(self, value: bytes) -> bytes:
        return self._cipher.decrypt(value[:12], value[12:], None)

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
            """SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked
               FROM (
                   SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked
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
                 created_at, expires_at, hop_count, max_hops, read_at, blocked)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
        # Message rows are durable history. Expiry only controls delivery and
        # queue eligibility; it must never erase a user's local conversation.
        await self._db.execute(
            "DELETE FROM seen_messages WHERE seen_at < ?", (now - 86400,)
        )
        await self._db.commit()

    async def save_group(self, group_id: str, name: str, owner_id: str, epoch: int) -> None:
        now = time.time()
        await self._db.execute(
            """INSERT INTO groups (group_id, name, owner_id, epoch, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET name=excluded.name, owner_id=excluded.owner_id,
                 epoch=excluded.epoch, updated_at=excluded.updated_at""",
            (group_id, name, owner_id, epoch, now, now),
        )
        await self._db.commit()

    async def get_groups(self) -> list[dict]:
        async with self._db.execute("SELECT * FROM groups ORDER BY name, group_id") as cursor:
            return [dict(row) async for row in cursor]

    async def save_group_member(self, group_id: str, peer_id: str, display_name: str, epoch: int, active: bool = True) -> None:
        await self._db.execute(
            """INSERT INTO group_members (group_id, peer_id, display_name, epoch, active)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(group_id, peer_id) DO UPDATE SET display_name=excluded.display_name,
                 epoch=excluded.epoch, active=excluded.active""",
            (group_id, peer_id, display_name, epoch, int(active)),
        )
        await self._db.commit()

    async def remove_group_member(self, group_id: str, peer_id: str) -> None:
        await self._db.execute("DELETE FROM group_members WHERE group_id = ? AND peer_id = ?", (group_id, peer_id))
        await self._db.commit()

    async def get_group_members(self, group_id: str, active_only: bool = True) -> list[dict]:
        query = "SELECT * FROM group_members WHERE group_id = ?"
        if active_only:
            query += " AND active = 1"
        query += " ORDER BY display_name, peer_id"
        async with self._db.execute(query, (group_id,)) as cursor:
            return [dict(row) async for row in cursor]

    async def save_group_message(self, message: dict) -> None:
        await self._db.execute(
            """INSERT OR IGNORE INTO group_messages
               (message_id, group_id, sender_id, sender_name, content, created_at, epoch, read_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                message["message_id"], message["group_id"], message["sender_id"],
                message.get("sender_name", "Unknown"), self._encrypt_content(message["content"]),
                message["created_at"], message["epoch"], message.get("read_at"),
            ),
        )
        await self._db.commit()

    async def is_group_message_seen(self, message_id: str) -> bool:
        async with self._db.execute(
            "SELECT 1 FROM group_messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def get_group_messages(self, group_id: str, limit: int = 200) -> list[dict]:
        async with self._db.execute(
            """SELECT message_id, group_id, sender_id, sender_name, content, created_at, epoch, read_at
               FROM (SELECT * FROM group_messages WHERE group_id = ? ORDER BY created_at DESC LIMIT ?)
               ORDER BY created_at ASC""",
            (group_id, limit),
        ) as cursor:
            messages = [dict(row) async for row in cursor]
        for message in messages:
            message["content"] = self._decrypt_content(message["content"])
        return messages

    async def mark_group_read(self, group_id: str) -> None:
        await self._db.execute("UPDATE group_messages SET read_at = ? WHERE group_id = ? AND read_at IS NULL", (time.time(), group_id))
        await self._db.commit()

    async def get_group_unread_counts(self) -> dict[str, int]:
        async with self._db.execute(
            "SELECT group_id, COUNT(*) AS unread_count FROM group_messages WHERE read_at IS NULL GROUP BY group_id"
        ) as cursor:
            return {row["group_id"]: row["unread_count"] async for row in cursor}

    async def save_pending_group_rekey(self, group_id: str, peer_id: str, epoch: int, payload: bytes) -> None:
        await self._db.execute(
            "INSERT OR REPLACE INTO group_pending_rekeys (group_id, peer_id, epoch, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (group_id, peer_id, epoch, payload, time.time()),
        )
        await self._db.commit()

    async def get_pending_group_rekeys(self, group_id: str | None = None) -> list[dict]:
        if group_id is None:
            query, params = "SELECT * FROM group_pending_rekeys ORDER BY created_at", ()
        else:
            query, params = "SELECT * FROM group_pending_rekeys WHERE group_id = ? ORDER BY created_at", (group_id,)
        async with self._db.execute(query, params) as cursor:
            return [dict(row) async for row in cursor]

    async def remove_pending_group_rekey(self, group_id: str, peer_id: str, epoch: int) -> None:
        await self._db.execute("DELETE FROM group_pending_rekeys WHERE group_id = ? AND peer_id = ? AND epoch = ?", (group_id, peer_id, epoch))
        await self._db.commit()

    async def history_size_bytes(self) -> int:
        try:
            return self.db_path.stat().st_size
        except OSError:
            return 0

    async def delete_history(
        self,
        conversation_type: str,
        conversation_id: str,
        before: float | None = None,
        local_peer_id: str | None = None,
    ) -> int:
        if conversation_type == "group":
            query = "DELETE FROM group_messages WHERE group_id = ?"
            params: tuple = (conversation_id,)
            if before is not None:
                query += " AND created_at < ?"
                params = (conversation_id, before)
        else:
            if not local_peer_id:
                raise ValueError("local_peer_id is required for direct-message history")
            query = "DELETE FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)"
            params = (local_peer_id, conversation_id, conversation_id, local_peer_id)
            if before is not None:
                query += " AND created_at < ?"
                params += (before,)
        cursor = await self._db.execute(query, params)
        await self._db.commit()
        return cursor.rowcount

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
