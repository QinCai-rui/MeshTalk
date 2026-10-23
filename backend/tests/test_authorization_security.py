"""Offline authorization checks using dummy identities and temporary databases."""

import asyncio
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from meshtalk.database import MAX_REQUESTS_PER_WINDOW, Database
from meshtalk.encryption import encrypt_for_recipient
from meshtalk.friends import FriendManager
from meshtalk.identity import Identity
from meshtalk.message_router import MessageRouter, MAX_MESSAGE_CONTENT_SIZE
from meshtalk.protocol import (
    FriendRequestCancelledPayload, FriendRequestPayload, FriendRequestResponsePayload,
    MessageBlockedPayload, MessagePayload, Packet, PacketType,
)


def connection(identity):
    return SimpleNamespace(peer_id=identity.peer_id, display_name=identity.display_name,
                           signing_public_key=identity.signing_public_key_bytes(),
                           encryption_public_key=identity.encryption_public_key_bytes(),
                           supports=lambda _: True)


class MemoryPeers:
    def __init__(self, *identities):
        self.peers = {identity.peer_id: connection(identity) for identity in identities}
        self.sent = []

    def get_connected_peer(self, peer_id):
        return self.peers.get(peer_id)

    async def send_packet(self, peer, packet):
        self.sent.append((peer.peer_id, packet))


def signed(identity, payload):
    payload.signature = identity.signing_private_key.sign(payload.signed_bytes())
    return payload


class AuthorizationSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.local, self.alice, self.bob = [Identity.generate(name) for name in ('Local', 'Alice', 'Bob')]
        self.db = Database(self.root / 'test.db')
        await self.db.connect()
        self.peers = MemoryPeers(self.alice, self.bob)
        self.friends = FriendManager(self.local, self.peers, self.db)
        self.delivered = []

        async def delivered(message_id):
            self.delivered.append(message_id)

        self.router = MessageRouter(self.local, self.peers, self.db, on_delivered=delivered,
                                    friend_manager=self.friends)

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def incoming_request(self, identity, request_id='incoming'):
        payload = signed(identity, FriendRequestPayload(request_id, identity.peer_id, '', time.time(), b''))
        await self.friends.handle_packet(connection(identity), Packet(PacketType.FRIEND_REQUEST, payload.encode()))

    async def outgoing_message(self, message_id='message', sender=None, recipient=None):
        await self.db.save_message(dict(message_id=message_id, sender_id=sender or self.local.peer_id,
                                       recipient_id=recipient or self.alice.peer_id, content='dummy',
                                       encrypted_content=b'', created_at=time.time(), hop_count=0,
                                       max_hops=0, queued=1))

    async def row(self, message_id='message'):
        async with self.db._db.execute('SELECT * FROM messages WHERE message_id = ?', (message_id,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def test_response_is_bound_to_requested_peer(self):
        request_id = await self.friends.send_friend_request(self.alice.peer_id)
        wrong = signed(self.bob, FriendRequestResponsePayload(request_id, self.bob.peer_id, True, b''))
        await self.friends.handle_packet(connection(self.bob), Packet(PacketType.FRIEND_REQUEST_RESPONSE, wrong.encode()))
        self.assertFalse(await self.db.is_friend(self.bob.peer_id))
        self.assertEqual((await self.db.get_friend_request(request_id))['status'], 'pending')
        correct = signed(self.alice, FriendRequestResponsePayload(request_id, self.alice.peer_id, True, b''))
        await self.friends.handle_packet(connection(self.alice), Packet(PacketType.FRIEND_REQUEST_RESPONSE, correct.encode()))
        self.assertTrue(await self.db.is_friend(self.alice.peer_id))

    async def test_cancellation_is_bound_to_request_sender(self):
        await self.incoming_request(self.alice)
        wrong = signed(self.bob, FriendRequestCancelledPayload('incoming', self.bob.peer_id, b''))
        await self.friends.handle_packet(connection(self.bob), Packet(PacketType.FRIEND_REQUEST_CANCELLED, wrong.encode()))
        self.assertEqual((await self.db.get_friend_request('incoming'))['status'], 'pending')
        correct = signed(self.alice, FriendRequestCancelledPayload('incoming', self.alice.peer_id, b''))
        await self.friends.handle_packet(connection(self.alice), Packet(PacketType.FRIEND_REQUEST_CANCELLED, correct.encode()))
        self.assertEqual((await self.db.get_friend_request('incoming'))['status'], 'cancelled')

    async def test_block_wins_over_stale_acceptance_snapshot(self):
        request_id = await self.friends.send_friend_request(self.alice.peer_id)
        original = self.db.get_friend_request
        read, release = asyncio.Event(), asyncio.Event()

        async def gated(request_id):
            row = await original(request_id)
            read.set()
            await release.wait()
            return row

        payload = signed(self.alice, FriendRequestResponsePayload(request_id, self.alice.peer_id, True, b''))
        with patch.object(self.db, 'get_friend_request', gated):
            task = asyncio.create_task(self.friends.handle_packet(connection(self.alice), Packet(PacketType.FRIEND_REQUEST_RESPONSE, payload.encode())))
            await asyncio.wait_for(read.wait(), 2)
            await self.friends.block_peer(self.alice.peer_id)
            release.set()
            await task
        self.assertTrue(await self.db.is_peer_blocked(self.alice.peer_id))
        self.assertFalse(await self.db.is_friend(self.alice.peer_id))
        self.assertEqual((await original(request_id))['status'], 'declined')

    async def test_ack_ignores_other_recipient_incoming_and_unknown_rows(self):
        await self.outgoing_message()
        await self.outgoing_message('incoming', self.alice.peer_id, self.local.peer_id)
        for message_id, peer in [('message', self.bob), ('incoming', self.alice), ('unknown', self.alice)]:
            await self.router.handle_packet(connection(peer), Packet(PacketType.MESSAGE_ACK, message_id.encode()))
        self.assertEqual((await self.row())['delivered'], 0)
        self.assertEqual((await self.row('incoming'))['delivered'], 0)
        self.assertEqual(self.delivered, [])
        await self.router.handle_packet(connection(self.alice), Packet(PacketType.MESSAGE_ACK, b'message'))
        self.assertEqual((await self.row())['delivered'], 1)
        self.assertEqual(self.delivered, ['message'])

    async def test_blocked_notice_requires_outgoing_message_to_reporter(self):
        await self.outgoing_message()
        await self.db.add_friend(self.bob.peer_id, 'Bob')
        notice = signed(self.bob, MessageBlockedPayload('message', self.bob.peer_id, b''))
        await self.friends.handle_packet(connection(self.bob), Packet(PacketType.MESSAGE_BLOCKED, notice.encode()))
        self.assertEqual((await self.row())['blocked'], 0)
        self.assertTrue(await self.db.is_friend(self.bob.peer_id))
        notice = signed(self.alice, MessageBlockedPayload('message', self.alice.peer_id, b''))
        await self.friends.handle_packet(connection(self.alice), Packet(PacketType.MESSAGE_BLOCKED, notice.encode()))
        self.assertEqual((await self.row())['blocked'], 1)

    async def test_direct_receiver_rejects_oversized_plaintext(self):
        await self.db.add_friend(self.alice.peer_id, 'Alice')
        payload = MessagePayload('large', self.alice.peer_id, self.local.peer_id, time.time(), 0, 0, b'')
        payload.encrypted_content = encrypt_for_recipient(self.local.encryption_public_key_bytes(), b'x' * (MAX_MESSAGE_CONTENT_SIZE + 1), payload.associated_data())
        signed(self.alice, payload)
        with self.assertRaises(ValueError):
            await self.router.handle_packet(connection(self.alice), Packet(PacketType.MESSAGE, payload.encode()))
        self.assertIsNone(await self.row('large'))

    def test_message_shape_and_nonfinite_timestamps(self):
        valid = json.loads(MessagePayload('id', self.alice.peer_id, self.local.peer_id, time.time(), 0, 0, b'cipher', b's' * 64).encode())
        for field, value in [('created_at', float('nan')), ('created_at', float('inf')), ('created_at', True), ('message_id', []), ('hop_count', False)]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                MessagePayload.decode(json.dumps({**valid, field: value}).encode())

    async def test_repeated_requests_are_bounded_without_deleting_chat(self):
        await self.outgoing_message()
        for number in range(8):
            request_id = f'request-{number}'
            await self.incoming_request(self.alice, request_id)
            cancel = signed(self.alice, FriendRequestCancelledPayload(request_id, self.alice.peer_id, b''))
            await self.friends.handle_packet(connection(self.alice), Packet(PacketType.FRIEND_REQUEST_CANCELLED, cancel.encode()))
        async with self.db._db.execute('SELECT COUNT(*) FROM friend_requests') as cursor:
            self.assertLessEqual((await cursor.fetchone())[0], MAX_REQUESTS_PER_WINDOW)
        self.assertIsNotNone(await self.row())

    async def test_database_permissions_and_symlink_rejection(self):
        self.assertEqual(stat.S_IMODE(self.db.db_path.stat().st_mode), 0o600)
        target = self.root / 'target'
        target.write_bytes(b'untouched')
        symlink = self.root / 'link.db'
        symlink.symlink_to(target)
        other = Database(symlink)
        try:
            with self.assertRaises((OSError, ValueError)):
                await other.connect()
        finally:
            await other.close()
        self.assertEqual(target.read_bytes(), b'untouched')


if __name__ == '__main__':
    unittest.main(verbosity=2)
