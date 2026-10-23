"""Offline room-card admission and derived identity retention checks."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from meshtalk.database import Database
from meshtalk.group_router import GroupRouter
from meshtalk.identity import Identity
from meshtalk.rendezvous import RendezvousService, encrypt_endpoint_card
from meshtalk.settings import Settings


class FakeUdp:
    def __init__(self):
        self.retained = set()

    def expect_peer(self, peer_id, endpoint):
        self.retained.add(peer_id)

    def expect_derp_peer(self, peer_id):
        self.retained.add(peer_id)

    def clear_direct_candidate(self, peer_id):
        pass

    def forget_candidate(self, peer_id):
        self.retained.discard(peer_id)


class RendezvousSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.db = Database(root / 'test.db')
        await self.db.connect()
        self.local = Identity.generate('Local')
        self.settings = Settings(root / 'settings.json')
        self.room = self.settings.create_room('Group')
        self.udp = FakeUdp()

        class MemoryPeers:
            def get_connected_peer(self, _):
                return None

        self.group = GroupRouter(self.local, MemoryPeers(), self.db, self.settings)
        await self.group.sync_groups()

        async def candidate(*_):
            pass

        self.service = RendezvousService(self.local, self.settings, self.udp, candidate, self.group.record_room_member)

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def test_empty_cards_consume_admission_before_durable_mutation(self):
        identities = [Identity.generate(str(number)) for number in range(4)]
        with patch('meshtalk.rendezvous.MAX_TRACKED_CANDIDATES', 2):
            for identity in identities:
                try:
                    await self.service._handle_card(self.room, encrypt_endpoint_card(identity, self.room, None, derp=False))
                except ValueError:
                    pass
        members = await self.db.get_group_members(self.room.id)
        self.assertLessEqual(len(members), 3)  # Two remote identities and ourselves.
        async with self.db._db.execute('SELECT COUNT(*) FROM peers WHERE public_key IS NULL') as cursor:
            self.assertLessEqual((await cursor.fetchone())[0], 2)
        self.assertEqual(len(self.service._candidate_seen), 2)

    async def test_invalid_endpoint_does_not_persist_identity(self):
        remote = Identity.generate('Remote')
        with self.assertRaises(ValueError):
            await self.service._handle_card(self.room, encrypt_endpoint_card(remote, self.room, ('192.168.1.5', 42424)))
        self.assertIsNone(await self.db.get_group_member(self.room.id, remote.peer_id))
        self.assertIsNone(await self.db.get_peer(remote.peer_id))

    async def test_expiry_forgets_udp_metadata(self):
        first, second = Identity.generate('First'), Identity.generate('Second')
        with patch('meshtalk.rendezvous.time.monotonic', return_value=1000):
            await self.service._handle_card(self.room, encrypt_endpoint_card(first, self.room, None))
        self.assertIn(first.peer_id, self.udp.retained)
        with patch('meshtalk.rendezvous.time.monotonic', return_value=1700):
            await self.service._handle_card(self.room, encrypt_endpoint_card(second, self.room, None))
        self.assertNotIn(first.peer_id, self.udp.retained)
        self.assertIn(second.peer_id, self.udp.retained)


if __name__ == '__main__':
    unittest.main(verbosity=2)
