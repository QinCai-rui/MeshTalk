import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from meshtalk.database import Database
from meshtalk.discovery import DiscoveryService
from meshtalk.identity import Identity
from meshtalk.peer_manager import PeerManager


class NetworkRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_refresh_remains_retryable_after_start_failure(self):
        service = DiscoveryService(24891, AsyncMock())
        service._running = True
        failing_start = AsyncMock(side_effect=OSError("socket unavailable"))
        with patch.object(service, "start", failing_start):
            with self.assertRaises(OSError):
                await service.refresh()
        self.assertTrue(service._running)

        retry_start = AsyncMock()
        with patch.object(service, "start", retry_start):
            await service.refresh()
        retry_start.assert_awaited_once()

    async def test_discovery_start_recovers_from_latched_failed_refresh(self):
        service = DiscoveryService(24891, AsyncMock())
        service._running = True
        loop = MagicMock()
        transport = MagicMock()
        transport.get_extra_info.return_value = None
        loop.create_datagram_endpoint = AsyncMock(return_value=(transport, MagicMock()))
        with patch("asyncio.get_event_loop", return_value=loop):
            await service.start()
        try:
            self.assertIs(service._transport, transport)
        finally:
            await service.stop()

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

    async def test_udp_restart_remains_retryable_after_start_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = Identity.generate("Alice")
            db = Database(root / "meshtalk.db")
            await db.connect()
            manager = PeerManager(identity, db, lambda *_: None, tcp_port=0)
            await manager.start()
            original_start = manager.udp.start
            try:
                failing_start = AsyncMock(side_effect=OSError("socket unavailable"))
                with patch.object(manager.udp, "start", failing_start):
                    with self.assertRaises(OSError):
                        await manager.udp.restart()
                self.assertTrue(manager.udp._started)

                manager.udp.start = original_start
                await manager.udp.restart()
                self.assertIsNotNone(manager.udp.local_endpoint)
            finally:
                await manager.stop()
                await db.close()
