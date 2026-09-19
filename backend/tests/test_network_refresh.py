import tempfile
import unittest
from pathlib import Path

from meshtalk.database import Database
from meshtalk.identity import Identity
from meshtalk.peer_manager import PeerManager


class NetworkRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_clears_stale_endpoints_and_rebinds_udp(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = Identity.generate("Alice")
            peer_identity = Identity.generate("Bob")
            db = Database(root / "meshtalk.db")
            await db.connect()
            peer_id = peer_identity.peer_id
            await db.upsert_peer(
                peer_id,
                "Bob",
                peer_identity.encryption_public_key_bytes(),
                peer_identity.signing_public_key_bytes(),
            )
            manager = PeerManager(identity, db, lambda *_: None, tcp_port=0)
            await manager.start()
            try:
                await manager.record_remote_candidate(peer_id, ("198.51.100.10", 40000))
                self.assertEqual(await db.load_peer_endpoints(), {
                    peer_id: {"remote_udp": ("198.51.100.10", 40000)}
                })
                await manager.refresh_network()
                self.assertEqual(manager._known_endpoints, {})
                self.assertEqual(await db.load_peer_endpoints(), {})
                self.assertIsNotNone(manager.udp.local_endpoint)
            finally:
                await manager.stop()
                await db.close()
