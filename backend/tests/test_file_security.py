"""Inbound file reservations are bounded and abandoned ones are reclaimed."""

import hashlib
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from meshtalk import file_transfer
from meshtalk.database import Database
from meshtalk.file_transfer import FileTransferManager
from meshtalk.identity import Identity
from meshtalk.protocol import FileOfferV2Payload, Packet, PacketType


def connection(identity):
    return SimpleNamespace(peer_id=identity.peer_id, display_name=identity.display_name,
                           signing_public_key=identity.signing_public_key_bytes(),
                           encryption_public_key=identity.encryption_public_key_bytes(),
                           supports=lambda _: True)


class FileSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.local, self.friend = Identity.generate('Local'), Identity.generate('Friend')
        self.db = Database(self.root / 'test.db')
        await self.db.connect()
        await self.db.add_friend(self.friend.peer_id, 'Friend')
        peers = SimpleNamespace(send_packet=AsyncMock(), get_connected_peer=lambda _: None)
        self.manager = FileTransferManager(self.local, peers, self.db, self.root / 'files')

    async def asyncTearDown(self):
        if self.manager._maintenance_task:
            self.manager._maintenance_task.cancel()
        await self.db.close()
        self.temp.cleanup()

    async def offer(self, size=1024 * 1024):
        offer = FileOfferV2Payload(file_id=uuid.uuid4().hex, sender_id=self.friend.peer_id,
                                   recipient_id=self.local.peer_id, filename='dummy.bin', file_size=size,
                                   chunk_size=16 * 1024, total_chunks=-(-size // (16 * 1024)),
                                   created_at=time.time(), file_sha256=hashlib.sha256(b'dummy').hexdigest())
        offer.signature = self.friend.signing_private_key.sign(offer.signed_bytes())
        await self.manager.handle_packet(connection(self.friend), Packet(PacketType.FILE_OFFER_V2, offer.encode()))
        return offer.file_id

    async def test_per_peer_reservation_limit(self):
        with patch.object(file_transfer, 'MAX_INBOUND_FILES_PER_PEER', 2):
            ids = [await self.offer() for _ in range(3)]
        rows = [await self.db.get_file_transfer(file_id) for file_id in ids]
        self.assertEqual([row is not None for row in rows], [True, True, False])
        self.assertEqual((await self.db.inbound_file_usage())['incomplete_count'], 2)

    async def test_total_byte_limit(self):
        with patch.object(file_transfer, 'MAX_INBOUND_BYTES_PER_PEER', 3 * 1024 * 1024):
            ids = [await self.offer(2 * 1024 * 1024) for _ in range(2)]
        self.assertIsNotNone(await self.db.get_file_transfer(ids[0]))
        self.assertIsNone(await self.db.get_file_transfer(ids[1]))

    async def test_abandoned_offer_is_reclaimed_and_history_kept(self):
        file_id = await self.offer()
        path = Path((await self.db.get_file_transfer(file_id))['file_path'])
        old = time.time() - file_transfer.INBOUND_IDLE_TTL - 60
        os.utime(path, (old, old))
        await self.manager.expire_abandoned_inbound()
        row = await self.db.get_file_transfer(file_id)
        self.assertFalse(path.exists())
        self.assertEqual(row['status'], 'failed')
        self.assertIsNone(row['file_path'])
        self.assertEqual((await self.db.inbound_file_usage())['incomplete_count'], 1)
        # The released row no longer counts against the quota.
        with patch.object(file_transfer, 'MAX_INBOUND_FILES_PER_PEER', 1):
            self.assertIsNotNone(await self.db.get_file_transfer(await self.offer()))

    async def test_recent_offer_is_kept(self):
        file_id = await self.offer()
        path = Path((await self.db.get_file_transfer(file_id))['file_path'])
        await self.manager.expire_abandoned_inbound()
        self.assertTrue(path.exists())
        self.assertEqual((await self.db.get_file_transfer(file_id))['status'], 'transferring')

    async def test_resend_requests_are_bounded(self):
        transfer = {'file_size': 32 * 1024, 'chunk_size': 16 * 1024}
        with patch.object(file_transfer, 'MAX_RESEND_REQUESTS_PER_PEER', 3):
            results = [self.manager._reserve_resend('peer', transfer, [(0, 1)]) for _ in range(5)]
        self.assertEqual(results, [True, True, True, False, False])

    async def test_revoked_recipient_stops_stream(self):
        transfer = {'group_id': None}
        self.assertTrue(await self.manager._still_authorized(transfer, self.friend.peer_id))
        await self.db.remove_friend(self.friend.peer_id)
        self.assertFalse(await self.manager._still_authorized(transfer, self.friend.peer_id))



class FileRevocationStatusTest(FileSecurityTest):
    async def test_local_group_departure_stops_stream(self):
        transfer = {'group_id': 'a' * 32}
        with patch.object(self.manager, '_group_recipient_eligible', AsyncMock(return_value=True)), \
                patch.object(self.manager, '_active_group_sender', AsyncMock(return_value=False)):
            self.assertFalse(await self.manager._still_authorized(transfer, self.friend.peer_id))

    async def test_expired_reservation_is_not_resumed(self):
        file_id = await self.offer()
        await self.db.update_file_transfer(file_id, status='failed', file_path=None)
        sent = []
        peer = connection(self.friend)
        self.manager.peer_manager.get_connected_peer = lambda _: peer
        with patch.object(self.manager, '_send_ack', AsyncMock(side_effect=lambda *a, **k: sent.append(a))):
            await self.manager.resume_for_peer(self.friend.peer_id)
        self.assertEqual(sent, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
