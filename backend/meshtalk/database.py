"""SQLite persistence layer.

Stores: identity, peers, messages, outgoing queue, seen message IDs.
"""

from __future__ import annotations

import time
import hashlib
import os
import json
import re
from pathlib import Path

import aiosqlite
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MENTION_TOKEN_RE = re.compile(r"<@([A-Za-z0-9_-]+)>")

# Matches a mention token only when its `<` is not escaped by an odd
# run of preceding backslashes; the backslash itself escapes the next
# character, and `\\` escapes to a literal `\`.
_MENTION_AT_RE = re.compile(r"<@([A-Za-z0-9_-]+)>")


def _is_escaped(content: str, index: int) -> bool:
    r"""Whether the character at *index* is escaped by a preceding `\`."""
    backslashes = 0
    i = index - 1
    while i >= 0 and content[i] == "\\":
        backslashes += 1
        i -= 1
    return backslashes % 2 == 1


def extract_mentions(content: str) -> list[str]:
    r"""Extract unique mentioned peer IDs (`<@user_id>` tokens) in order.

    A token `\<@id>` (odd backslashes before `<`) is an escaped literal and
    does not count as a mention; `\\` collapses to a single `\` so
    `\\<@id>` is a mention preceded by a literal `\`.
    """
    if not isinstance(content, str) or not content:
        return []
    seen: set[str] = set()
    mentions: list[str] = []
    for match in _MENTION_AT_RE.finditer(content):
        if _is_escaped(content, match.start()):
            continue
        peer_id = match.group(1)
        if peer_id not in seen:
            seen.add(peer_id)
            mentions.append(peer_id)
    return mentions


def render_mentions_plain(content: str, names: dict[str, str]) -> str:
    r"""Render `<@user_id>` tokens as plain `@Display Name` text.

    Used for recipients without mention support so mentions stay readable
    instead of arriving as raw tokens. Escape rules mirror the rich client:
    `\\` becomes `\`, `\<@id>` renders the literal `<@id>`, and `\\<@id>`
    is a mention preceded by a literal `\`. A lone `\` before any other
    character is left untouched.
    """
    parts: list[str] = []
    i = 0
    n = len(content)
    while i < n:
        ch = content[i]
        if ch == "\\" and i + 1 < n and content[i + 1] == "\\":
            parts.append("\\")
            i += 2
            continue
        if ch == "\\":
            match = MENTION_TOKEN_RE.match(content, i + 1)
            if match:
                parts.append(match.group(0))
                i += 1 + len(match.group(0))
                continue
        if ch == "<":
            match = MENTION_TOKEN_RE.match(content, i)
            if match:
                peer_id = match.group(1)
                parts.append("@everyone" if peer_id == "everyone" else "@" + names.get(peer_id, "unknown"))
                i += len(match.group(0))
                continue
        parts.append(ch)
        i += 1
    return "".join(parts)

SCHEMA = """
CREATE TABLE IF NOT EXISTS peers (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT 'Anonymous',
    public_key BLOB,
    signing_public_key BLOB,
    last_seen REAL,
    is_online INTEGER NOT NULL DEFAULT 0,
    tui_active INTEGER NOT NULL DEFAULT 0,
    capabilities TEXT
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
    received_at REAL,
    reply_to_message_id TEXT
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
    kind TEXT NOT NULL DEFAULT 'message',
    reply_to_message_id TEXT,
    origin_signature BLOB
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
    received_chunks INTEGER NOT NULL DEFAULT 0,
    file_sha256 TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    batch_id TEXT,
    batch_index INTEGER,
    batch_count INTEGER,
    awaiting_ack_at REAL
);

CREATE TABLE IF NOT EXISTS file_deliveries (
    file_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at REAL NOT NULL,
    awaiting_ack_at REAL,
    PRIMARY KEY (file_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS file_received_chunks (
    file_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    PRIMARY KEY (file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group_created ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outgoing_queue_recipient ON outgoing_queue(recipient_id, attempts);

CREATE TABLE IF NOT EXISTS group_relay_cursors (
    peer_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    last_rowid INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (peer_id, group_id)
);
"""

MAX_GROUP_HISTORY_ROWS = 5000
# Absolute per-group history bound, applied even to undelivered rows: a single
# vanished member must not pin storage forever via in-flight deliveries.
HARD_MAX_GROUP_HISTORY_ROWS = 10000
# Upper bound on queued group packets per recipient; beyond this the sender
# stops queueing (marks unavailable) instead of growing the queue without end.
MAX_QUEUED_GROUP_PER_PEER = 200


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
        try:
            cursor_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_relay_cursors)")}
            if cursor_columns and "last_rowid" not in cursor_columns:
                # Pre-release schema used a timestamp cursor; rowid cursors
                # replace it (best-effort cache, safe to rebuild).
                await self._db.execute("DROP TABLE IF EXISTS group_relay_cursors")
                await self._db.execute(
                    """CREATE TABLE IF NOT EXISTS group_relay_cursors (
                        peer_id TEXT NOT NULL, group_id TEXT NOT NULL,
                        last_rowid INTEGER NOT NULL, updated_at REAL NOT NULL,
                        PRIMARY KEY (peer_id, group_id))"""
                )
        except Exception:
            pass
        columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(peers)")}
        if "signing_public_key" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN signing_public_key BLOB")
        if "tui_active" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN tui_active INTEGER NOT NULL DEFAULT 0")
        if "dnd" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN dnd INTEGER NOT NULL DEFAULT 0")
        if "lan_endpoint" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN lan_endpoint TEXT")
        if "remote_endpoint" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN remote_endpoint TEXT")
        if "capabilities" not in columns:
            await self._db.execute("ALTER TABLE peers ADD COLUMN capabilities TEXT")
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
        if "reply_to_message_id" not in message_columns:
            await self._db.execute("ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT")
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
        file_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(file_transfers)")}
        file_migrations = {
            "file_sha256": "TEXT NOT NULL DEFAULT ''",
            "caption": "TEXT NOT NULL DEFAULT ''",
            "batch_id": "TEXT",
            "batch_index": "INTEGER",
            "batch_count": "INTEGER",
            "awaiting_ack_at": "REAL",
        }
        for column, definition in file_migrations.items():
            if column not in file_columns:
                await self._db.execute(f"ALTER TABLE file_transfers ADD COLUMN {column} {definition}")
        delivery_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(file_deliveries)")}
        if "awaiting_ack_at" not in delivery_columns:
            await self._db.execute("ALTER TABLE file_deliveries ADD COLUMN awaiting_ack_at REAL")
        # Migrate group_messages table (older DBs lacked received_at/kind)
        try:
            gm_columns = {row[1] async for row in await self._db.execute("PRAGMA table_info(group_messages)")}
            if gm_columns and "received_at" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN received_at REAL")
            if gm_columns and "kind" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'")
            if gm_columns and "content" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN content BLOB")
            if gm_columns and "reply_to_message_id" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN reply_to_message_id TEXT")
            if gm_columns and "origin_signature" not in gm_columns:
                await self._db.execute("ALTER TABLE group_messages ADD COLUMN origin_signature BLOB")
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
        db = self._db
        if db:
            try:
                await db.commit()
            except BaseException:
                # Cleanup must not hide the commit failure that triggered shutdown.
                try:
                    await db.close()
                except Exception:
                    pass
                self._db = None
                raise
            else:
                try:
                    await db.close()
                finally:
                    self._db = None

    async def get_peer(self, peer_id: str) -> dict | None:
        """Retrieve peer information by peer ID."""
        async with self._db.execute(
            "SELECT * FROM peers WHERE peer_id = ?", (peer_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def upsert_peer(
        self, peer_id: str, display_name: str, public_key: bytes, signing_public_key: bytes,
        tui_active: bool = False, capabilities: list[str] | None = None,
        dnd: bool | None = None,
    ) -> None:
        """Insert or update peer information including keys and online status."""
        await self._db.execute(
            """INSERT INTO peers (peer_id, display_name, public_key, signing_public_key, last_seen, is_online, tui_active, capabilities, dnd)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
               ON CONFLICT(peer_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 public_key = excluded.public_key,
                 signing_public_key = excluded.signing_public_key,
                 last_seen = excluded.last_seen,
                  is_online = 1,
                  tui_active = excluded.tui_active,
                  dnd = CASE WHEN ? IS NULL THEN peers.dnd ELSE excluded.dnd END,
                  capabilities = COALESCE(excluded.capabilities, peers.capabilities)""",
            (
                peer_id, display_name, public_key, signing_public_key, time.time(), int(tui_active),
                json.dumps(sorted(set(capabilities))) if capabilities is not None else None,
                int(dnd) if dnd is not None else 0, dnd,
            ),
        )
        await self._db.commit()

    async def upsert_peer_signing_key(self, peer_id: str, signing_public_key: bytes) -> bool:
        """Cache a verified signing key without touching other peer state.

        Used for keys learned from room endpoint cards (which carry no
        encryption key and say nothing about online status). The key must be
        self-certifying (peer_id == SHA-256(key)); returns False otherwise.
        Existing display names, encryption keys, capabilities, online state,
        and last_seen are kept: a card sighting is not direct contact.
        """
        if (
            not isinstance(signing_public_key, (bytes, bytearray))
            or len(signing_public_key) != 32
            or hashlib.sha256(bytes(signing_public_key)).hexdigest() != peer_id
        ):
            return False
        existing = await self.get_peer(peer_id)
        if existing and existing.get("signing_public_key") == bytes(signing_public_key):
            return True
        await self._db.execute(
            """INSERT INTO peers (peer_id, display_name, public_key, signing_public_key, is_online)
               VALUES (?, ?, ?, ?, 0)
               ON CONFLICT(peer_id) DO UPDATE SET
                 signing_public_key = excluded.signing_public_key""",
            (
                peer_id,
                (existing or {}).get("display_name", "Anonymous"),
                (existing or {}).get("public_key"),
                bytes(signing_public_key),
            ),
        )
        await self._db.commit()
        return True

    async def peer_supports(self, peer_id: str, capability: str) -> bool:
        """Check a capability learned from the peer's most recent handshake."""
        async with self._db.execute("SELECT capabilities FROM peers WHERE peer_id = ?", (peer_id,)) as cursor:
            row = await cursor.fetchone()
        if not row or not row["capabilities"]:
            return False
        try:
            return capability in json.loads(row["capabilities"])
        except (TypeError, json.JSONDecodeError):
            return False

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
            """SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued, failed, received_at, reply_to_message_id
               FROM (
                     SELECT message_id, sender_id, recipient_id, content, created_at, delivered, blocked, queued, failed, received_at, reply_to_message_id
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
            message["content"] = self._decrypt_content(message["content"]) or ""
            if isinstance(message["content"], bytes):
                message["content"] = message["content"].decode("utf-8", errors="replace")
        return messages

    async def save_message(self, msg: dict) -> None:
        """Store a message in the database with encrypted content."""
        await self._db.execute(
            """INSERT OR IGNORE INTO messages
                (message_id, sender_id, recipient_id, content, encrypted_content,
                  created_at, hop_count, max_hops, read_at, blocked, queued, failed, received_at, reply_to_message_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                msg.get("reply_to_message_id"),
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
        """Remove seen message IDs older than 24 hours and dead queue rows."""
        now = time.time()
        await self._db.execute(
            "DELETE FROM seen_messages WHERE seen_at < ?", (now - 86400,)
        )
        # Queue rows that exhausted their retry budget are never selected
        # again; reap them so a malicious peer cannot grow the table forever.
        await self._db.execute("DELETE FROM outgoing_queue WHERE attempts >= 5")
        await self._db.commit()

    async def has_queued_payload(self, recipient_id: str, packet_type: int, payload: bytes) -> bool:
        """Whether an identical payload is already queued for the recipient."""
        async with self._db.execute(
            """SELECT 1 FROM outgoing_queue
               WHERE recipient_id = ? AND packet_type = ? AND encrypted_payload = ? AND attempts < 5
               LIMIT 1""",
            (recipient_id, packet_type, payload),
        ) as cursor:
            return await cursor.fetchone() is not None

    async def count_queued_packets(self, recipient_id: str, packet_type: int) -> int:
        """Count pending queued packets of one type for a recipient."""
        async with self._db.execute(
            """SELECT COUNT(*) AS n FROM outgoing_queue
               WHERE recipient_id = ? AND packet_type = ? AND attempts < 5""",
            (recipient_id, packet_type),
        ) as cursor:
            row = await cursor.fetchone()
            return int(row["n"]) if row else 0

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

    async def mark_message_queued(self, message_id: str) -> None:
        """Mark a message as queued for later delivery."""
        await self._db.execute(
            "UPDATE messages SET queued = 1 WHERE message_id = ?", (message_id,)
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

    async def delete_message_locally(self, message_id: str, group_id: str | None = None) -> bool:
        """Remove a message and its local history row without notifying peers."""
        await self._db.execute("DELETE FROM outgoing_queue WHERE message_id = ?", (message_id,))
        if group_id is None:
            cursor = await self._db.execute(
                "DELETE FROM messages WHERE message_id = ?",
                (message_id,),
            )
        else:
            cursor = await self._db.execute(
                "DELETE FROM group_messages WHERE message_id = ? AND group_id = ?",
                (message_id, group_id),
            )
            await self._db.execute("DELETE FROM group_deliveries WHERE message_id = ?", (message_id,))
        await self._db.commit()
        return cursor.rowcount > 0

    async def delete_file_transfer_locally(self, file_id: str, files_base: Path) -> dict | None:
        """Remove all local metadata associated with an attachment."""
        transfer = await self.get_file_transfer(file_id)
        if transfer is None:
            return None
        await self._db.execute("DELETE FROM file_transfers WHERE file_id = ?", (file_id,))
        await self._db.execute("DELETE FROM file_received_chunks WHERE file_id = ?", (file_id,))
        await self._db.execute("DELETE FROM file_deliveries WHERE file_id = ?", (file_id,))
        await self._db.execute("DELETE FROM outgoing_queue WHERE message_id = ?", (file_id,))
        await self._db.execute("DELETE FROM seen_messages WHERE message_id = ?", (file_id,))
        await self._db.commit()
        file_path = transfer.get("file_path")
        if file_path and await self.count_file_path_references(file_path) == 0:
            path = Path(file_path)
            try:
                base = files_base.resolve()
                path.resolve().relative_to(base)
                path.unlink(missing_ok=True)
                if path.parent.resolve() != base:
                    path.parent.rmdir()
            except (OSError, ValueError):
                pass
        return transfer

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

    async def get_group_mention_unread_count(self, group_id: str, local_peer_id: str) -> int:
        """Count unread messages in a group that mention the local peer."""
        async with self._db.execute(
            """SELECT content FROM group_messages
               WHERE group_id = ? AND sender_id != ?
                 AND received_at > COALESCE(
                   (SELECT read_at FROM groups WHERE group_id = ?), 0
                 )""",
            (group_id, local_peer_id, group_id),
        ) as cursor:
            mention_count = 0
            async for row in cursor:
                try:
                    content = self._decrypt_content(row["content"]) or ""
                except (InvalidTag, ValueError, UnicodeDecodeError):
                    # A corrupt message must not hide mention counts for the
                    # other rows in this group.
                    continue
                mentions = extract_mentions(content)
                if local_peer_id in mentions or "everyone" in mentions:
                    mention_count += 1
            return mention_count

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
                (message_id, group_id, sender_id, content, created_at, received_at, kind, reply_to_message_id, origin_signature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                message["message_id"], message["group_id"], message["sender_id"],
                self._encrypt_content(content) if content is not None else None,
                message["created_at"], message.get("received_at"), message.get("kind", "message"),
                message.get("reply_to_message_id"), message.get("origin_signature"),
            ),
        )
        await self._db.commit()
        if cursor.rowcount > 0:
            await self._prune_group_history(message["group_id"])
        return cursor.rowcount > 0

    async def _prune_group_history(self, group_id: str) -> None:
        """Drop oldest group history beyond the retention bound.

        Only rows no one is still waiting for are eligible up to the soft
        bound: anything with a non-terminal delivery (pending/queued/sent)
        is kept, so floods cannot evict an offline member's undelivered
        backlog. A hard cap bounds pathological pinning (e.g. a vanished
        member holding deliveries open forever). Derived delivery rows and
        queued group packets for pruned messages are removed in the same
        savepoint, which nests safely under concurrent writers.
        """
        await self._db.execute("SAVEPOINT group_prune")
        try:
            async with self._db.execute(
                "SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ?", (group_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row and row["n"] > MAX_GROUP_HISTORY_ROWS + 100:
                await self._db.execute(
                    """DELETE FROM group_messages WHERE group_id = ? AND message_id NOT IN (
                         SELECT message_id FROM group_messages WHERE group_id = ?
                         ORDER BY rowid DESC LIMIT ?) AND message_id NOT IN (
                         SELECT message_id FROM group_deliveries
                         WHERE status NOT IN ('delivered', 'unavailable'))""",
                    (group_id, group_id, MAX_GROUP_HISTORY_ROWS),
                )
            async with self._db.execute(
                "SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ?", (group_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row and row["n"] > HARD_MAX_GROUP_HISTORY_ROWS:
                await self._db.execute(
                    """DELETE FROM group_messages WHERE group_id = ? AND message_id NOT IN (
                         SELECT message_id FROM group_messages WHERE group_id = ?
                         ORDER BY rowid DESC LIMIT ?)""",
                    (group_id, group_id, HARD_MAX_GROUP_HISTORY_ROWS),
                )
            await self._db.execute(
                """DELETE FROM group_deliveries WHERE message_id NOT IN (
                     SELECT message_id FROM group_messages)"""
            )
            await self._db.execute(
                """DELETE FROM outgoing_queue WHERE group_id = ? AND message_id IS NOT NULL
                   AND message_id NOT IN (SELECT message_id FROM group_messages)""",
                (group_id,),
            )
            await self._db.execute("RELEASE group_prune")
            await self._db.commit()
        except Exception:
            try:
                await self._db.execute("ROLLBACK TO group_prune")
                await self._db.execute("RELEASE group_prune")
            except Exception:  # noqa: BLE001
                pass
            raise

    async def get_group_messages(self, group_id: str, limit: int = 200) -> list[dict]:
        """Retrieve recent group messages with delivery status."""
        async with self._db.execute(
            """SELECT message_id, group_id, sender_id, content, created_at, received_at, kind, reply_to_message_id, origin_signature
               FROM (SELECT rowid AS sequence, * FROM group_messages WHERE group_id = ? ORDER BY rowid DESC LIMIT ?)
               ORDER BY sequence ASC""",
            (group_id, limit),
        ) as cursor:
            messages = [dict(row) async for row in cursor]
        for message in messages:
            message["content"] = self._decrypt_content(message["content"]) or ""
            if message["origin_signature"] is not None:
                message["origin_signature"] = message["origin_signature"].hex()
            message["mentions"] = extract_mentions(message["content"])
            message["deliveries"] = []
        if messages:
            by_id = {message["message_id"]: message for message in messages}
            for message_id, deliveries in (await self.get_group_deliveries_many(list(by_id))).items():
                by_id[message_id]["deliveries"] = deliveries
        return messages

    async def get_group_deliveries_many(self, message_ids: list[str]) -> dict[str, list[dict]]:
        """Get delivery status for several group messages in one query."""
        grouped: dict[str, list[dict]] = {}
        if not message_ids:
            return grouped
        placeholders = ",".join("?" for _ in message_ids)
        async with self._db.execute(
            f"""SELECT d.message_id, d.recipient_id,
                       COALESCE(p.display_name, gm.display_name, d.recipient_id) AS display_name,
                       d.status, d.updated_at
                FROM group_deliveries d
                LEFT JOIN group_messages m ON m.message_id = d.message_id
                LEFT JOIN group_members gm ON gm.group_id = m.group_id AND gm.peer_id = d.recipient_id
                LEFT JOIN peers p ON p.peer_id = d.recipient_id
                WHERE d.message_id IN ({placeholders}) ORDER BY display_name""",
            tuple(message_ids),
        ) as cursor:
            async for row in cursor:
                grouped.setdefault(row["message_id"], []).append(dict(row))
        return grouped

    async def get_relay_cursor(self, peer_id: str, group_id: str) -> int | None:
        """Return the rowid high-water mark relayed to a peer, if any."""
        async with self._db.execute(
            "SELECT last_rowid FROM group_relay_cursors WHERE peer_id = ? AND group_id = ?",
            (peer_id, group_id),
        ) as cursor:
            row = await cursor.fetchone()
            return int(row["last_rowid"]) if row else None

    async def set_relay_cursor(self, peer_id: str, group_id: str, last_rowid: int) -> None:
        """Advance the relay high-water mark; only moves forward."""
        await self._db.execute(
            """INSERT INTO group_relay_cursors (peer_id, group_id, last_rowid, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(peer_id, group_id) DO UPDATE SET
                 last_rowid = max(group_relay_cursors.last_rowid, excluded.last_rowid),
                 updated_at = excluded.updated_at""",
            (peer_id, group_id, int(last_rowid), time.time()),
        )
        await self._db.commit()

    async def get_group_messages_for_relay(
        self, group_id: str, since: float, limit: int,
        after: int | None = None,
    ) -> list[dict]:
        """Retrieve relayable messages SQL-side, in insertion order.

        Only real messages at/after ``since`` (and past the ``after`` resume
        cursor rowid, when given) are returned, already bounded to ``limit``
        rows, so sweeps never decrypt or scan more than they can send.
        Ordering by ``rowid`` (not sender-controlled ``created_at``) keeps a
        malicious future timestamp from skipping other history. Delivery
        rows are intentionally omitted: the relay does not need them and the
        recipient tracks its own state by message_id.
        """
        if limit <= 0:
            return []
        if after is not None:
            query = """SELECT rowid, message_id, group_id, sender_id, content, created_at, reply_to_message_id, origin_signature
               FROM group_messages
               WHERE group_id = ? AND kind = 'message' AND created_at >= ? AND rowid > ?
               ORDER BY rowid ASC LIMIT ?"""
            params: tuple = (group_id, since, after, limit)
        else:
            query = """SELECT rowid, message_id, group_id, sender_id, content, created_at, reply_to_message_id, origin_signature
               FROM group_messages
               WHERE group_id = ? AND kind = 'message' AND created_at >= ?
               ORDER BY rowid ASC LIMIT ?"""
            params = (group_id, since, limit)
        async with self._db.execute(query, params) as cursor:
            messages = [dict(row) async for row in cursor]
        for message in messages:
            message["content"] = self._decrypt_content(message["content"]) or ""
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
               (file_id, filename, file_size, chunk_size, total_chunks, sender_id, recipient_id, group_id, direction, status, file_path, created_at, completed_at, received_chunks, file_sha256, caption, batch_id, batch_index, batch_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                transfer["file_id"], transfer["filename"], transfer["file_size"], transfer["chunk_size"],
                transfer["total_chunks"], transfer["sender_id"], transfer["recipient_id"], transfer.get("group_id"),
                transfer["direction"], transfer["status"], transfer.get("file_path"), transfer["created_at"],
                transfer.get("completed_at"), transfer.get("received_chunks", 0),
                transfer.get("file_sha256", ""), transfer.get("caption", ""), transfer.get("batch_id"),
                transfer.get("batch_index"), transfer.get("batch_count"),
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

    async def get_file_transfers(self, peer_id: str | None = None, group_id: str | None = None, include_group: bool = False) -> list[dict]:
        """Retrieve file transfers filtered by peer ID or group ID.

        A peer-only query returns direct transfers only (group_id IS NULL)
        so group fan-out rows do not leak into DM history. Pass
        include_group=True for internal per-peer delivery paths (flush/resume)
        that must still see queued group transfers for that peer.
        """
        query = "SELECT * FROM file_transfers"
        clauses: list[str] = []
        params: list[str] = []
        if peer_id:
            peer_clause = "(sender_id = ? OR recipient_id = ?)"
            params.extend([peer_id, peer_id])
            if include_group:
                peer_clause = "(" + peer_clause + " OR EXISTS (SELECT 1 FROM file_deliveries d WHERE d.file_id = file_transfers.file_id AND d.recipient_id = ?))"
                params.append(peer_id)
            clauses.append(peer_clause)
            if not group_id and not include_group:
                # Falsy group_id (None, or "" which IPC validation already
                # rejects) means a DM listing: direct transfers only. Wire
                # decode only yields None or a 32-hex id, and direct rows
                # store NULL, so IS NULL cannot hide a real group row.
                clauses.append("group_id IS NULL")
        if group_id:
            clauses.append("group_id = ?")
            params.append(group_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC"
        async with self._db.execute(query, tuple(params)) as cursor:
            return [dict(row) async for row in cursor]

    async def set_file_delivery(self, file_id: str, recipient_id: str, status: str) -> None:
        """Create or update one recipient's delivery state."""
        await self._db.execute(
            """INSERT INTO file_deliveries (file_id, recipient_id, status, updated_at, awaiting_ack_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(file_id, recipient_id) DO UPDATE SET
                 status = excluded.status, updated_at = excluded.updated_at,
                 awaiting_ack_at = excluded.awaiting_ack_at""",
            (file_id, recipient_id, status, time.time(), time.time() if status == "sent" else None),
        )
        await self._db.commit()

    async def get_file_delivery(self, file_id: str, recipient_id: str) -> dict | None:
        """Return one recipient's delivery state."""
        async with self._db.execute(
            "SELECT * FROM file_deliveries WHERE file_id = ? AND recipient_id = ?",
            (file_id, recipient_id),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_file_deliveries(self, file_id: str) -> list[dict]:
        """Return all recipient states for a logical file send."""
        async with self._db.execute(
            "SELECT * FROM file_deliveries WHERE file_id = ? ORDER BY recipient_id", (file_id,)
        ) as cursor:
            return [dict(row) async for row in cursor]

    async def delete_file_delivery(self, file_id: str, recipient_id: str) -> bool:
        """Delete one recipient's delivery state."""
        cursor = await self._db.execute(
            "DELETE FROM file_deliveries WHERE file_id = ? AND recipient_id = ?",
            (file_id, recipient_id),
        )
        await self._db.commit()
        return cursor.rowcount > 0

    async def remove_file_from_outqueue(self, file_id: str, recipient_id: str | None = None) -> int:
        """Delete queued file packets, optionally scoped to one recipient."""
        if recipient_id is None:
            cursor = await self._db.execute("DELETE FROM outgoing_queue WHERE message_id = ?", (file_id,))
        else:
            cursor = await self._db.execute(
                "DELETE FROM outgoing_queue WHERE message_id = ? AND recipient_id = ?",
                (file_id, recipient_id),
            )
        await self._db.commit()
        return cursor.rowcount

    async def count_file_path_references(self, file_path: str | Path) -> int:
        """Count transfer rows sharing a local file path."""
        async with self._db.execute(
            "SELECT COUNT(*) FROM file_transfers WHERE file_path = ?", (str(file_path),)
        ) as cursor:
            return (await cursor.fetchone())[0]

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

    async def record_file_chunk_received(
        self, file_id: str, chunk_index: int, *, commit: bool = True
    ) -> int:
        """Mark a file chunk as received and return total received chunks count.

        File receivers can commit progress in bounded batches. The default
        remains durable per call for other callers and resume-sensitive paths.
        """
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
        if commit:
            await self._db.commit()
        return received_chunks

    async def commit(self) -> None:
        """Commit pending changes made by a batched operation."""
        await self._db.commit()

    async def reset_file_received_chunks(self, file_id: str) -> None:
        """Drop all received-chunk state so a full integrity retry overwrites every chunk."""
        await self._db.execute("DELETE FROM file_received_chunks WHERE file_id = ?", (file_id,))
        await self._db.execute("UPDATE file_transfers SET received_chunks = 0 WHERE file_id = ?", (file_id,))

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
