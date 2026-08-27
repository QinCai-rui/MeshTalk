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
    hop_count INTEGER NOT NULL DEFAULT 0,
    max_hops INTEGER NOT NULL DEFAULT 10,
    delivered INTEGER NOT NULL DEFAULT 0,
    stored INTEGER NOT NULL DEFAULT 0,
    queued INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    read_at REAL,
    received_at REAL
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

CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    joined_at REAL NOT NULL,
    read_at REAL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT 'Anonymous',
    joined_at REAL NOT NULL,
    last_seen REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    left_at REAL,
    group_capable INTEGER,
    join_announced INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, peer_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
    message_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content BLOB,
    created_at REAL NOT NULL,
    received_at REAL,
    kind TEXT NOT NULL DEFAULT 'message'
);

CREATE TABLE IF NOT EXISTS group_deliveries (
    message_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (message_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS file_transfers (
    file_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    group_id TEXT,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    file_path TEXT,
    created_at REAL NOT NULL,
    completed_at REAL,
    received_chunks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_received_chunks (
    file_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    PRIMARY KEY (file_id, chunk_index)
);
"""


class Database:
    """SQLite database interface for persistent storage of peers, messages, and metadata."""

    def __init__(self, db_path: Path, storage_key: bytes | None = None) -> None:
        """Initialize database connection with optional encryption key for message content."""
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None
        self._cipher = AESGCM(storage_key or os.urandom(32))

    async def connect(self) -> None:
        """Connect to the database and apply schema migrations."""
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
        if "failed" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN failed INTEGER NOT NULL DEFAULT 0")
        if "received_at" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN received_at REAL")
        if "expires_at" in message_columns:
            try:
                await self._db.execute("ALTER TABLE messages DROP COLUMN expires_at")
            except Exception:
                pass
        queue_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(outgoing_queue)")}
        if "packet_type" not in queue_columns:
            await self._db.execute("ALTER TABLE outgoing_queue ADD COLUMN packet_type INTEGER NOT NULL DEFAULT 0")
        if "group_id" not in queue_columns:
            await self._db.execute("ALTER TABLE outgoing_queue ADD COLUMN group_id TEXT")
        friend_request_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(friend_requests)")}
        if "recipient_id" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_id TEXT NOT NULL DEFAULT ''")
        if "recipient_name" not in friend_request_columns:
            await self._db.execute("ALTER TABLE friend_requests ADD COLUMN recipient_name TEXT NOT NULL DEFAULT ''")
        group_member_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_members)")}
        if "group_capable" not in group_member_columns:
            await self._db.execute("ALTER TABLE group_members ADD COLUMN group_capable INTEGER")
        if "join_announced" not in group_member_columns:
            await self._db.execute("ALTER TABLE group_members ADD COLUMN join_announced INTEGER NOT NULL DEFAULT 0")
        # Migrate groups table from very old DBs that lacked joined_at/read_at
        try:
            group_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(groups)")}
            if group_columns and "joined_at" not in group_columns:
                await self._db.execute("ALTER TABLE groups ADD COLUMN joined_at REAL NOT NULL DEFAULT 0")
            if group_columns and "read_at" not in group_columns:
                await self._db.execute("ALTER TABLE groups ADD COLUMN read_at REAL")
            if group_columns and "name" not in group_columns:
                await self._db.execute("ALTER TABLE groups ADD COLUMN name TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        # Migrate group_messages table (older DBs lacked received_at/kind)
        try:
            gm_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_messages)")}
            if gm_columns and "received_at" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN received_at REAL")
            if gm_columns and "kind" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'")
            if gm_columns and "content" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN content BLOB")
        except Exception:
            pass
        # Ensure group_deliveries exists (older DBs may lack it entirely - SCHEMA already handled)
        try:
            gd_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_deliveries)")}
            if not gd_columns:
                await self._db.execute("CREATE TABLE IF NOT EXISTS group_deliveries (message_id TEXT NOT NULL, recipient_id TEXT NOT NULL, status TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (message_id, recipient_id))")
        except Exception:
            pass
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
        """Close the database connection."""
        if self._db:
            await self._db.close()

    async def get_peer(self, peer_id: str) -> dict | None:
        """Retrieve peer information by peer ID."""
        async with self._db.execute(
            "SELECT * FROM peers WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def upsert_peer(
        self, peer_id: str, display_name: str, public_key: bytes, signing_public_key: bytes, tui_active: bool = False
    ) -> None:
        """Insert or update peer information including keys and online status."""
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
        """Update peer online status and last seen timestamp."""
        await self._db.execute(
            "UPDATE peers SET is_online = ?, last_seen = ? WHERE peer_id = ?",
            (1 if online else 0, time.time(), peer_id),
        )
        await self._db.commit()

    async def get_online_peers(self) -> list[dict]:
        """Retrieve all peers currently marked as online."""
        async with self._db.execute(
            "SELECT * FROM peers WHERE is_online = 1"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def get_all_peers(self) -> list[dict]:
        """Retrieve all peers from the database."""
        async with self._db.execute("SELECT * FROM peers") as cursor:
            return [dict(row) async for row in cursor]

    async def remove_peer(self, peer_id: str) -> None:
        """Delete a peer from the database."""
        await self._db.execute("DELETE FROM peers WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def save_peer_endpoint(self, peer_id: str, transport: str, endpoint: tuple[str, int] | None) -> None:
        """Store or clear a peer's network endpoint for LAN or remote transport."""
        column = "lan_endpoint" if transport == "lan_tcp" else "remote_endpoint"
        value = f"{endpoint[0]}:{endpoint[1]}" if endpoint else None
        await self._db.execute(
            f"UPDATE peers SET {column} = ? WHERE peer_id = ?", (value, peer_id)
        )
        await self._db.commit()

    async def load_peer_endpoints(self) -> dict[str, dict[str, tuple[str, int]]]:
        """Load stored network endpoints for all peers from the database."""
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
        """Get count of unread messages grouped by sender peer ID."""
        async with self._db.execute(
            """SELECT sender_id, COUNT(*) AS unread_count
               FROM messages
               WHERE recipient_id = ? AND read_at IS NULL
               GROUP BY sender_id""",
            (local_peer_id,),
        ) as cursor:
            return {row["sender_id"]: row["unread_count"] async for row in cursor}

    async def get_peer_interaction_times(self, local_peer_id: str) -> dict[str, float]:
        """Return the latest direct message or completed file activity for each peer."""
        async with self._db.execute(
            """SELECT peer_id, MAX(interacted_at) AS last_interaction
               FROM (
                   SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
                          CASE WHEN sender_id = ? THEN created_at ELSE COALESCE(received_at, created_at) END AS interacted_at
                   FROM messages
                   WHERE sender_id = ? OR recipient_id = ?
                   UNION ALL
                   SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
                          COALESCE(completed_at, created_at) AS interacted_at
                   FROM file_transfers
                   WHERE group_id IS NULL
                     AND status IN ('sent', 'completed')
                     AND (sender_id = ? OR recipient_id = ?)
               )
               GROUP BY peer_id""",
            (local_peer_id, local_peer_id, local_peer_id, local_peer_id, local_peer_id, local_peer_id, local_peer_id),
        ) as cursor:
            return {row["peer_id"]: row["last_interaction"] async for row in cursor}

    async def get_conversation(
        self, local_peer_id: str, remote_peer_id: str, limit: int = 200
    ) -> list[dict]:
        """Return the latest direct messages with one peer in chronological order."""
        async with self._db.execute(
            """SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued, failed, received_at
               FROM (
                    SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued, failed, received_at
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
        """Store a message in the database with encrypted content."""
        await self._db.execute(
            """INSERT OR IGNORE INTO messages
                (message_id, sender_id, recipient_id, content, encrypted_content,
                  created_at, hop_count, max_hops, read_at, blocked, queued, failed, received_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg["message_id"],
                msg["sender_id"],
                msg["recipient_id"],
                self._encrypt_content(msg["content"]) if msg.get("content") is not None else None,
                msg["encrypted_content"],
                msg["created_at"],
                msg["hop_count"],
                msg["max_hops"],
                msg.get("read_at"),
                msg.get("blocked", 0),
                msg.get("queued", 0),
                msg.get("failed", 0),
                msg.get("received_at"),
            ),
        )
        await self._db.commit()

    async def mark_conversation_read(self, local_peer_id: str, remote_peer_id: str) -> None:
        """Mark all messages from a specific peer as read."""
        await self._db.execute(
            """UPDATE messages SET read_at = ?
               WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL""",
            (time.time(), remote_peer_id, local_peer_id),
        )
        await self._db.commit()

    async def is_message_seen(self, message_id: str) -> bool:
        """Check if a message ID has been seen before (for deduplication)."""
        async with self._db.execute(
            "SELECT 1 FROM seen_messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def mark_message_seen(self, message_id: str) -> None:
        """Record that a message ID has been seen (for deduplication)."""
        await self._db.execute(
            "INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?, ?)",
            (message_id, time.time()),
        )
        await self._db.commit()

    async def cleanup_expired(self) -> None:
        """Remove seen message IDs older than 24 hours."""
        now = time.time()
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
        group_id: str | None = None,
    ) -> None:
        """Add a packet to the outgoing queue for a recipient."""
        await self._db.execute(
            """INSERT INTO outgoing_queue
               (message_id, recipient_id, packet_type, encrypted_payload, created_at, group_id)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (message_id, recipient_id, packet_type, encrypted_payload, time.time(), group_id),
        )
        await self._db.commit()

    async def get_pending_outgoing(self, recipient_id: str | None = None) -> list[dict]:
        """Retrieve pending outgoing queue items for a specific recipient or all recipients."""
        if recipient_id is None:
            query = "SELECT * FROM outgoing_queue WHERE attempts < 5"
            params: tuple = ()
        else:
            query = "SELECT * FROM outgoing_queue WHERE recipient_id = ? AND attempts < 5"
            params = (recipient_id,)
        async with self._db.execute(query, params) as cursor:
            return [dict(row) async for row in cursor]

    async def increment_outqueue_attempts(self, queue_id: int) -> None:
        """Increment the attempt counter for an outgoing queue item."""
        await self._db.execute(
            "UPDATE outgoing_queue SET attempts = attempts + 1, last_attempt = ? WHERE id = ?",
            (time.time(), queue_id),
        )
        await self._db.commit()

    async def remove_from_outqueue(self, queue_id: int) -> None:
        """Remove an item from the outgoing queue."""
        await self._db.execute(
            "DELETE FROM outgoing_queue WHERE id = ?", (queue_id,)
        )
        await self._db.commit()

    async def get_stored_messages_for(self, peer_id: str) -> list[dict]:
        """Retrieve stored messages waiting to be delivered to a peer."""
        async with self._db.execute(
            """SELECT * FROM messages
               WHERE recipient_id = ? AND stored = 1""",
            (peer_id,),
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def mark_message_delivered(self, message_id: str) -> None:
        """Mark a message as delivered to its recipient."""
        await self._db.execute(
            "UPDATE messages SET delivered = 1, queued = 0, received_at = ? WHERE message_id = ?",
            (time.time(), message_id),
        )
        await self._db.commit()

    async def mark_message_sent(self, message_id: str) -> None:
        """Mark a message as successfully sent (not necessarily delivered)."""
        await self._db.execute(
            "UPDATE messages SET queued = 0 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def mark_message_blocked(self, message_id: str) -> None:
        """Mark a message as blocked by the recipient."""
        await self._db.execute(
            "UPDATE messages SET blocked = 1 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def mark_message_failed(self, message_id: str) -> None:
        """Mark a message as failed to send."""
        await self._db.execute(
            "UPDATE messages SET failed = 1, queued = 0 WHERE message_id = ?", (message_id,)
        )
        await self._db.commit()

    async def upsert_group(self, group_id: str, name: str) -> None:
        """Insert or update a group with its name."""
        await self._db.execute(
            """INSERT INTO groups (group_id, name, joined_at) VALUES (?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET name = excluded.name""",
            (group_id, name, time.time()),
        )
        await self._db.commit()

    async def get_group(self, group_id: str) -> dict | None:
        """Retrieve group information by group ID."""
        async with self._db.execute(
            "SELECT * FROM groups WHERE group_id = ?", (group_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def remove_group(self, group_id: str) -> None:
        """Remove a group and its associated data from the database."""
        # History remains local so rejoining restores the user's previous view,
        # but pending traffic must not escape after membership is removed.
        await self._db.execute("DELETE FROM outgoing_queue WHERE group_id = ?", (group_id,))
        await self._db.execute("DELETE FROM groups WHERE group_id = ?", (group_id,))
        await self._db.execute("DELETE FROM group_members WHERE group_id = ?", (group_id,))
        await self._db.commit()

    async def get_groups(self, local_peer_id: str) -> list[dict]:
        """Retrieve all groups with member counts and unread message counts."""
        async with self._db.execute(
            """SELECT g.group_id, g.name, g.joined_at,
                      COUNT(DISTINCT CASE WHEN gm.active = 1 THEN gm.peer_id END) AS member_count,
                      COUNT(DISTINCT CASE WHEN m.sender_id != ? AND m.received_at > COALESCE(g.read_at, 0) THEN m.message_id END) AS unread_count
               FROM groups g
               LEFT JOIN group_members gm ON gm.group_id = g.group_id
               LEFT JOIN group_messages m ON m.group_id = g.group_id
               GROUP BY g.group_id, g.name, g.joined_at
               ORDER BY g.name""",
            (local_peer_id,),
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def upsert_group_member(
        self,
        group_id: str,
        peer_id: str,
        display_name: str,
        active: bool = True,
        group_capable: bool | None = None,
    ) -> bool:
        """Insert or update a group member, returning True if member newly joined."""
        existing = await self.get_group_member(group_id, peer_id)
        now = time.time()
        await self._db.execute(
            """INSERT INTO group_members (group_id, peer_id, display_name, joined_at, last_seen, active, left_at, group_capable)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
               ON CONFLICT(group_id, peer_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 last_seen = excluded.last_seen,
                 active = excluded.active,
                 left_at = NULL,
                 group_capable = COALESCE(excluded.group_capable, group_members.group_capable),
                 join_announced = CASE
                   WHEN group_members.active = 0 AND excluded.active = 1 THEN 0
                   ELSE group_members.join_announced
                 END""",
            (group_id, peer_id, display_name, now, now, int(active), None if group_capable is None else int(group_capable)),
        )
        await self._db.commit()
        return existing is None or not bool(existing["active"])

    async def claim_group_join_announcement(self, group_id: str, peer_id: str) -> bool:
        """Mark a member's join as announced, returning True if it was pending announcement."""
        cursor = await self._db.execute(
            """UPDATE group_members SET join_announced = 1
               WHERE group_id = ? AND peer_id = ? AND active = 1 AND join_announced = 0""",
            (group_id, peer_id),
        )
        await self._db.commit()
        return cursor.rowcount > 0

    async def get_group_member(self, group_id: str, peer_id: str) -> dict | None:
        """Retrieve a specific group member by group ID and peer ID."""
        async with self._db.execute(
            "SELECT * FROM group_members WHERE group_id = ? AND peer_id = ?", (group_id, peer_id)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_group_members(self, group_id: str, include_inactive: bool = False) -> list[dict]:
        """Retrieve all members of a group, optionally including inactive members."""
        query = "SELECT * FROM group_members WHERE group_id = ?"
        if not include_inactive:
            query += " AND active = 1"
        query += " ORDER BY display_name"
        async with self._db.execute(query, (group_id,)) as cursor:
            return [dict(row) async for row in cursor]

    async def mark_group_member_left(self, group_id: str, peer_id: str) -> None:
        """Mark a group member as having left the group."""
        await self._db.execute(
            "UPDATE group_members SET active = 0, left_at = ? WHERE group_id = ? AND peer_id = ?",
            (time.time(), group_id, peer_id),
        )
        await self._db.commit()

    async def save_group_message(self, message: dict) -> bool:
        """Save a group message, returning True if the message was newly inserted."""
        content = message.get("content")
        cursor = await self._db.execute(
            """INSERT OR IGNORE INTO group_messages
               (message_id, group_id, sender_id, content, created_at, received_at, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                message["message_id"], message["group_id"], message["sender_id"],
                self._encrypt_content(content) if content is not None else None,
                message["created_at"], message.get("received_at"), message.get("kind", "message"),
            ),
        )
        await self._db.commit()
        return cursor.rowcount > 0

    async def get_group_messages(self, group_id: str, limit: int = 200) -> list[dict]:
        """Retrieve recent group messages with delivery status."""
        async with self._db.execute(
            """SELECT message_id, group_id, sender_id, content, created_at, received_at, kind
               FROM (SELECT rowid AS sequence, * FROM group_messages WHERE group_id = ? ORDER BY rowid DESC LIMIT ?)
               ORDER BY sequence ASC""",
            (group_id, limit),
        ) as cursor:
            messages = [dict(row) async for row in cursor]
        for message in messages:
            message["content"] = self._decrypt_content(message["content"])
            message["deliveries"] = await self.get_group_deliveries(message["message_id"])
        return messages

    async def get_group_message(self, message_id: str) -> dict | None:
        """Retrieve a specific group message by message ID."""
        async with self._db.execute(
            "SELECT * FROM group_messages WHERE message_id = ?", (message_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def mark_group_read(self, group_id: str) -> None:
        """Mark all messages in a group as read."""
        await self._db.execute("UPDATE groups SET read_at = ? WHERE group_id = ?", (time.time(), group_id))
        await self._db.commit()

    async def set_group_delivery(self, message_id: str, recipient_id: str, status: str) -> None:
        """Record or update delivery status for a group message to a specific recipient."""
        await self._db.execute(
            """INSERT INTO group_deliveries (message_id, recipient_id, status, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(message_id, recipient_id) DO UPDATE SET
                 status = CASE
                   WHEN group_deliveries.status = 'delivered' THEN 'delivered'
                   ELSE excluded.status
                 END,
                 updated_at = CASE
                   WHEN group_deliveries.status = 'delivered' THEN group_deliveries.updated_at
                   ELSE excluded.updated_at
                 END""",
            (message_id, recipient_id, status, time.time()),
        )
        await self._db.commit()

    async def get_group_deliveries(self, message_id: str) -> list[dict]:
        """Get delivery status for all recipients of a group message."""
        async with self._db.execute(
            """SELECT d.recipient_id, COALESCE(p.display_name, gm.display_name, d.recipient_id) AS display_name,
                      d.status, d.updated_at
               FROM group_deliveries d
               LEFT JOIN group_messages m ON m.message_id = d.message_id
               LEFT JOIN group_members gm ON gm.group_id = m.group_id AND gm.peer_id = d.recipient_id
               LEFT JOIN peers p ON p.peer_id = d.recipient_id
               WHERE d.message_id = ? ORDER BY display_name""",
            (message_id,),
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def add_friend(self, peer_id: str, display_name: str) -> None:
        """Add a peer as a friend or update their display name."""
        await self._db.execute(
            """INSERT INTO friends (peer_id, display_name, created_at) VALUES (?, ?, ?)
               ON CONFLICT(peer_id) DO UPDATE SET display_name = excluded.display_name""",
            (peer_id, display_name, time.time()),
        )
        await self._db.commit()

    async def remove_friend(self, peer_id: str) -> None:
        """Remove a peer from the friends list."""
        await self._db.execute("DELETE FROM friends WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def is_friend(self, peer_id: str) -> bool:
        """Check if a peer is in the friends list."""
        async with self._db.execute(
            "SELECT 1 FROM friends WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def get_friends(self) -> list[dict]:
        """Retrieve all friends sorted by display name."""
        async with self._db.execute(
            "SELECT peer_id, display_name, created_at FROM friends ORDER BY display_name"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def save_friend_request(self, request: dict) -> None:
        """Store a friend request in the database."""
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
        """Retrieve a specific friend request by request ID."""
        async with self._db.execute(
            "SELECT * FROM friend_requests WHERE request_id = ?", (request_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_pending_friend_requests(self) -> list[dict]:
        """Retrieve all pending friend requests."""
        async with self._db.execute(
            "SELECT * FROM friend_requests WHERE status = 'pending' ORDER BY created_at DESC"
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def get_pending_request_with(self, peer_id: str, direction: str) -> dict | None:
        """Find a pending friend request with a specific peer in a given direction."""
        column = "sender_id" if direction == "incoming" else "recipient_id"
        async with self._db.execute(
            f"""SELECT * FROM friend_requests
                WHERE status = 'pending' AND direction = ? AND {column} = ? LIMIT 1""",
            (direction, peer_id),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def update_friend_request_status(self, request_id: str, status: str) -> None:
        """Update the status of a friend request (e.g., accepted, declined)."""
        await self._db.execute(
            "UPDATE friend_requests SET status = ?, responded_at = ? WHERE request_id = ?",
            (status, time.time(), request_id),
        )
        await self._db.commit()

    async def decline_pending_requests_with(self, peer_id: str) -> None:
        """Decline all pending friend requests involving a specific peer."""
        await self._db.execute(
            """UPDATE friend_requests SET status = 'declined', responded_at = ?
               WHERE status = 'pending' AND (sender_id = ? OR recipient_id = ?)""",
            (time.time(), peer_id, peer_id),
        )
        await self._db.commit()

    async def cancel_friend_request(self, request_id: str) -> None:
        """Cancel a friend request by request ID."""
        await self._db.execute(
            "UPDATE friend_requests SET status = 'cancelled', responded_at = ? WHERE request_id = ?",
            (time.time(), request_id),
        )
        await self._db.commit()

    async def cancel_incoming_requests_with(self, peer_id: str) -> None:
        """Cancel all pending incoming friend requests from a specific peer."""
        await self._db.execute(
            """UPDATE friend_requests SET status = 'cancelled', responded_at = ?
               WHERE status = 'pending' AND direction = 'incoming' AND sender_id = ?""",
            (time.time(), peer_id),
        )
        await self._db.commit()

    async def block_peer(self, peer_id: str, display_name: str) -> None:
        """Add a peer to the blocked list."""
        await self._db.execute(
            """INSERT INTO blocked_peers (peer_id, display_name, created_at) VALUES (?, ?, ?)
               ON CONFLICT(peer_id) DO UPDATE SET display_name = excluded.display_name""",
            (peer_id, display_name, time.time()),
        )
        await self._db.commit()

    async def unblock_peer(self, peer_id: str) -> None:
        """Remove a peer from the blocked list."""
        await self._db.execute("DELETE FROM blocked_peers WHERE peer_id = ?", (peer_id,))
        await self._db.commit()

    async def is_peer_blocked(self, peer_id: str) -> bool:
        """Check if a peer is blocked."""
        async with self._db.execute(
            "SELECT 1 FROM blocked_peers WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            return await cursor.fetchone() is not None

    async def get_blocked_peers(self) -> list[dict]:
        """Retrieve all blocked peers."""
        async with self._db.execute(
            "SELECT peer_id, display_name, created_at FROM blocked_peers ORDER BY display_name"
        ) as cursor:
            return [dict(row) async for row in cursor]

    # ------------------------------------------------------------------ file transfers
    async def save_file_transfer(self, transfer: dict) -> None:
        """Store or update a file transfer record in the database."""
        await self._db.execute(
            """INSERT OR REPLACE INTO file_transfers
               (file_id, filename, file_size, chunk_size, total_chunks, sender_id, recipient_id, group_id, direction, status, file_path, created_at, completed_at, received_chunks)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                transfer["file_id"], transfer["filename"], transfer["file_size"], transfer["chunk_size"],
                transfer["total_chunks"], transfer["sender_id"], transfer["recipient_id"], transfer.get("group_id"),
                transfer["direction"], transfer["status"], transfer.get("file_path"), transfer["created_at"],
                transfer.get("completed_at"), transfer.get("received_chunks", 0),
            ),
        )
        await self._db.commit()

    async def get_file_transfer(self, file_id: str) -> dict | None:
        """Retrieve a file transfer record by file ID."""
        async with self._db.execute("SELECT * FROM file_transfers WHERE file_id = ?", (file_id,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def update_file_transfer(self, file_id: str, **fields) -> None:
        """Update specific fields of a file transfer record."""
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [file_id]
        await self._db.execute(f"UPDATE file_transfers SET {sets} WHERE file_id = ?", tuple(values))
        await self._db.commit()

    async def get_file_transfers(self, peer_id: str | None = None, group_id: str | None = None) -> list[dict]:
        """Retrieve file transfers filtered by peer ID or group ID."""
        query = "SELECT * FROM file_transfers"
        clauses: list[str] = []
        params: list[str] = []
        if peer_id:
            clauses.append("(sender_id = ? OR recipient_id = ?)")
            params.extend([peer_id, peer_id])
        if group_id:
            clauses.append("group_id = ?")
            params.append(group_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC"
        async with self._db.execute(query, tuple(params)) as cursor:
            return [dict(row) async for row in cursor]

    async def get_pending_file_offers(self) -> list[dict]:
        """Retrieve all file transfers that are pending or actively transferring."""
        async with self._db.execute("SELECT * FROM file_transfers WHERE status IN ('pending','transferring')") as cursor:
            return [dict(row) async for row in cursor]

    async def is_file_chunk_received(self, file_id: str, chunk_index: int) -> bool:
        """Check if a specific file chunk has been received."""
        async with self._db.execute(
            "SELECT 1 FROM file_received_chunks WHERE file_id = ? AND chunk_index = ?",
            (file_id, chunk_index),
        ) as cursor:
            return await cursor.fetchone() is not None

    async def record_file_chunk_received(self, file_id: str, chunk_index: int) -> int:
        """Mark a file chunk as received and return total received chunks count."""
        await self._db.execute(
            "INSERT OR IGNORE INTO file_received_chunks (file_id, chunk_index) VALUES (?, ?)",
            (file_id, chunk_index),
        )
        async with self._db.execute(
            "SELECT COUNT(*) FROM file_received_chunks WHERE file_id = ?", (file_id,)
        ) as cursor:
            received_chunks = (await cursor.fetchone())[0]
        await self._db.execute(
            "UPDATE file_transfers SET received_chunks = ? WHERE file_id = ?",
            (received_chunks, file_id),
        )
        await self._db.commit()
        return received_chunks

    async def get_missing_file_chunk_ranges(self, file_id: str, total_chunks: int) -> list[tuple[int, int]]:
        """Calculate contiguous ranges of missing file chunks."""
        async with self._db.execute(
            "SELECT chunk_index FROM file_received_chunks WHERE file_id = ? ORDER BY chunk_index",
            (file_id,),
        ) as cursor:
            received = {row[0] async for row in cursor}
        ranges: list[tuple[int, int]] = []
        start: int | None = None
        for index in range(total_chunks):
            if index not in received and start is None:
                start = index
            elif index in received and start is not None:
                ranges.append((start, index - 1))
                start = None
        if start is not None:
            ranges.append((start, total_chunks - 1))
        return ranges

    async def complete_file_transfer(self, file_id: str, completed_at: float) -> None:
        """Mark a file transfer as completed and clean up chunk tracking data."""
        await self._db.execute(
            "UPDATE file_transfers SET status = 'completed', completed_at = ? WHERE file_id = ?",
            (completed_at, file_id),
        )
        await self._db.execute("DELETE FROM file_received_chunks WHERE file_id = ?", (file_id,))
        await self._db.commit()
