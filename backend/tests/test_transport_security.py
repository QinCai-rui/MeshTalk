"""Bounded in-memory checks for transport admission and handshake lifetimes."""

import asyncio
from collections import deque
import unittest
from unittest.mock import patch

from meshtalk import discovery, peer_manager, udp_transport
from meshtalk.discovery import DiscoveryService
from meshtalk.identity import Identity
from meshtalk.peer_manager import PeerConnection, PeerManager, PeerState
from meshtalk.protocol import DiscoveryPacket, Packet, PacketType
from meshtalk.udp_transport import Attempt, HELLO, READY, UdpTransport


async def _ignore(*_, **__):
    pass


class _Database:
    def __init__(self, block=False):
        self.reads = 0
        self.both_reading = asyncio.Event()
        self.release = asyncio.Event()
        if not block:
            self.release.set()

    async def get_peer(self, *_):
        self.reads += 1
        if self.reads == 2:
            self.both_reading.set()
        await self.release.wait()
        return None

    upsert_peer = _ignore
    set_peer_online = _ignore
    save_peer_endpoint = _ignore


class _Writer:
    def __init__(self, destination):
        self.destination = destination
        self.closed = False

    def write(self, data):
        if not self.closed:
            self.destination.feed_data(data)

    async def drain(self):
        await asyncio.sleep(0)

    def close(self):
        if not self.closed:
            self.closed = True
            self.destination.feed_eof()

    async def wait_closed(self):
        pass

    def get_extra_info(self, name):
        return ("192.0.2.1", 40000)


def _stream_pair():
    left, right = asyncio.StreamReader(), asyncio.StreamReader()
    return (left, _Writer(right)), (right, _Writer(left))


class TcpAdmissionSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def _race(self, inbound):
        low, high = sorted(
            [Identity.generate("One"), Identity.generate("Two")],
            key=lambda identity: identity.peer_id,
        )
        db = _Database(block=True)
        local = PeerManager(high if inbound else low, db, _ignore, capabilities=[])
        remote = PeerManager(low if inbound else high, _Database(), _ignore, capabilities=[])
        local._running = True
        handlers, handshakes, local_streams = [], [], []
        for _ in range(2):
            local_stream, remote_stream = _stream_pair()
            local_streams.append(local_stream)
            peer = PeerConnection("", "192.0.2.1", 40000)
            peer.reader, peer.writer = remote_stream
            if inbound:
                handlers.append(asyncio.create_task(local._handle_incoming(*local_stream)))
                handshake = remote._outbound_handshake(peer)
            else:
                handshake = remote._inbound_handshake(peer)
            handshakes.append(asyncio.create_task(handshake))
        streams = iter(local_streams)

        async def connect(*_):
            return next(streams)

        try:
            with patch.object(peer_manager.asyncio, "open_connection", connect):
                if not inbound:
                    handlers = [asyncio.create_task(local.connect_to_peer(None, "192.0.2.1", port))
                                for port in (40001, 40002)]
                await asyncio.wait_for(asyncio.gather(*handshakes), 1)
                await asyncio.wait_for(db.both_reading.wait(), 1)
                db.release.set()
                await asyncio.wait_for(asyncio.gather(*handlers), 1)
            self.assertEqual(len(local.peers), 1)
            self.assertEqual(sum(not writer.closed for _, writer in local_streams), 1,
                             "duplicate admission retained two authenticated writers")
            self.assertEqual(len(local._receive_tasks), 1)
        finally:
            db.release.set()
            for task in [*handlers, *handshakes]:
                task.cancel()
            await asyncio.gather(*handlers, *handshakes, return_exceptions=True)
            await local.stop()

    async def test_inbound_same_identity_admission_is_atomic(self):
        await self._race(inbound=True)

    async def test_anonymous_outbound_same_identity_admission_is_atomic(self):
        await self._race(inbound=False)

    async def test_connect_deadline_releases_connection_slot(self):
        manager = PeerManager(Identity.generate("Local"), _Database(), _ignore)
        manager._running = True
        cancelled = asyncio.Event()

        async def stalled_connect(*_):
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        try:
            with patch.object(peer_manager, "CONNECT_TIMEOUT", 0.01, create=True), \
                    patch.object(peer_manager.asyncio, "open_connection", stalled_connect):
                task = asyncio.create_task(manager.connect_to_peer(None, "192.0.2.1", 40000))
                done, _ = await asyncio.wait([task], timeout=0.2)
                self.assertIn(task, done, "TCP connect has no application deadline")
                await task
            self.assertTrue(cancelled.is_set())
            self.assertFalse(manager._connecting)
            self.assertFalse(manager._connection_tasks)
        finally:
            await manager.stop()


class DiscoveryDeadlineSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def test_worker_recovers_from_stalled_and_failed_callbacks(self):
        calls = []
        recovered = asyncio.Event()

        async def found(host, port):
            calls.append(port)
            if port == 40001:
                await asyncio.Future()
            if port == 40002:
                raise OSError("dummy callback failure")
            recovered.set()

        service = DiscoveryService(40000, found)
        service._running = True
        with patch.object(discovery, "DISCOVERY_CALLBACK_TIMEOUT", 0.01, create=True):
            worker = asyncio.create_task(service._discovery_worker())
            try:
                for index in range(1, 4):
                    packet = DiscoveryPacket(discovery_id=f"{index:032x}", tcp_port=40000 + index)
                    service.enqueue_discovery(packet.encode(), ("192.0.2.1", 24890))
                done, _ = await asyncio.wait([asyncio.create_task(recovered.wait())], timeout=0.2)
                self.assertTrue(done, "discovery worker did not recover")
                await asyncio.wait_for(service._pending.join(), 0.2)
                self.assertEqual(calls, [40001, 40002, 40003])
                self.assertNotIn(f"{1:032x}", service._known_addresses)
                self.assertNotIn(f"{2:032x}", service._known_addresses)
            finally:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)


class _Datagrams:
    """A manually drained queue. No sockets, timers, or recursive delivery."""

    def __init__(self):
        self.queue = deque()
        self.a_endpoint, self.b_endpoint = ("192.0.2.1", 40001), ("192.0.2.2", 40002)
        self.a = UdpTransport(Identity.generate("One"), _ignore, _ignore, _ignore)
        self.b = UdpTransport(Identity.generate("Two"), _ignore, _ignore, _ignore)
        self.a._sendto = lambda data, _: self.queue.append((self.b, data, self.a_endpoint))
        self.b._sendto = lambda data, _: self.queue.append((self.a, data, self.b_endpoint))
        self.remote_attempt = Attempt(self.a.identity.peer_id, self.a_endpoint)
        self.hello = self.b._make_hello(self.remote_attempt)
        self.remote_attempt.hello = self.hello

    def deliver(self, limit=24):
        for _ in range(limit):
            if not self.queue:
                return
            target, data, source = self.queue.popleft()
            target.datagram_received(data, source)

    def confirm(self):
        self.b._attempts[self.a.identity.peer_id] = self.remote_attempt
        self.a.datagram_received(self.hello, self.b_endpoint)
        self.deliver()
        assert self.a._sessions[self.b.identity.peer_id].confirmed
        assert self.b._sessions[self.a.identity.peer_id].confirmed
        assert not self.a._attempts and not self.b._attempts

    async def close(self):
        await self.a.stop()
        await self.b.stop()


class UdpHandshakeSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def test_confirmed_duplicate_hello_chain_terminates(self):
        wire = _Datagrams()
        try:
            wire.confirm()
            wire.queue.clear()
            wire.a.datagram_received(wire.hello, wire.b_endpoint)
            wire.deliver(limit=12)
            self.assertFalse(wire.queue, "confirmed HELLO replies still produce reciprocal work")
        finally:
            await wire.close()

    async def test_unconfirmed_duplicate_hello_work_is_bounded(self):
        wire = _Datagrams()
        try:
            wire.a.datagram_received(wire.hello, wire.b_endpoint)
            wire.queue.clear()
            for _ in range(24):
                wire.a.datagram_received(wire.hello, wire.b_endpoint)
            self.assertLess(len(wire.queue), 12, "every redundant HELLO produced replies")
        finally:
            await wire.close()

    async def test_lost_hello_and_ready_recover(self):
        for lost_type in (HELLO, READY):
            with self.subTest(lost_type=lost_type):
                wire = _Datagrams()
                try:
                    wire.b._attempts[wire.a.identity.peer_id] = wire.remote_attempt
                    wire.a.datagram_received(wire.hello, wire.b_endpoint)
                    dropped = False
                    for _ in range(24):
                        if not wire.queue:
                            break
                        target, data, source = wire.queue.popleft()
                        if data[4] == lost_type and not dropped:
                            dropped = True
                            continue
                        target.datagram_received(data, source)
                    # A scheduled punch retry is independent of receive-driven replies.
                    for transport in (wire.a, wire.b):
                        for attempt in list(transport._attempts.values()):
                            transport._send_route(attempt.hello, attempt.endpoint, attempt.via_relay)
                    wire.deliver()
                    self.assertTrue(wire.a._sessions[wire.b.identity.peer_id].confirmed)
                    self.assertTrue(wire.b._sessions[wire.a.identity.peer_id].confirmed)
                    self.assertFalse(wire.a._attempts or wire.b._attempts)
                finally:
                    await wire.close()

    async def test_stale_different_hello_preserves_confirmed_same_route(self):
        wire = _Datagrams()
        try:
            wire.confirm()
            active = wire.a._sessions[wire.b.identity.peer_id]
            stale = wire.b._make_hello(Attempt(wire.a.identity.peer_id, wire.a_endpoint))
            wire.queue.clear()
            wire.a.datagram_received(stale, wire.b_endpoint)
            self.assertIs(wire.a._sessions[wire.b.identity.peer_id], active,
                          "a signed HELLO replaced a confirmed route before fresh READY")
            self.assertIs(wire.a._sessions_by_id.get(active.session_id), active)
            self.assertNotIn(active.session_id, wire.a._retiring_sessions)
            frame = wire.b._encrypt_fragment(wire.b._sessions[wire.a.identity.peer_id],
                                             1, 0, 1, Packet(PacketType.PING).encode())
            wire.a.datagram_received(frame, wire.b_endpoint)
            self.assertIn(1, active.seen)
        finally:
            await wire.close()

    async def test_forget_candidate_removes_pending_not_established_sessions(self):
        wire = _Datagrams()
        try:
            wire.confirm()
            peer_id = wire.b.identity.peer_id
            active = wire.a._sessions[peer_id]
            wire.a._direct_candidates[peer_id] = wire.b_endpoint
            wire.a._expected_endpoints[peer_id] = (wire.b_endpoint, 0)
            wire.a._last_direct_probe[peer_id] = 1
            wire.a.expect_derp_peer(peer_id)
            stale = wire.b._make_hello(Attempt(wire.a.identity.peer_id, wire.a_endpoint))
            wire.a.datagram_received(stale, wire.b_endpoint)
            attempt = wire.a._attempts[peer_id]
            wire.a.forget_candidate(peer_id)
            await asyncio.sleep(0)
            self.assertNotIn(peer_id, wire.a._direct_candidates)
            self.assertNotIn(peer_id, wire.a._expected_endpoints)
            self.assertNotIn(peer_id, wire.a._derp_candidates)
            self.assertNotIn(peer_id, wire.a._last_direct_probe)
            self.assertNotIn(peer_id, wire.a._attempts)
            self.assertNotIn(peer_id, wire.a._pending_sessions)
            self.assertTrue(attempt.task.cancelled())
            self.assertIs(wire.a._sessions[peer_id], active)
            self.assertEqual(list(wire.a._sessions_by_id.values()), [active])
        finally:
            await wire.close()


    async def test_forgotten_relay_routing_is_dropped_when_session_ends(self):
        wire = _Datagrams()
        try:
            wire.confirm()
            peer_id = wire.b.identity.peer_id
            active = wire.a._sessions[peer_id]
            active.via_relay = True
            wire.a.expect_derp_peer(peer_id)
            wire.a.forget_candidate(peer_id)
            self.assertIn(peer_id, wire.a._derp_candidates, "an active relay session lost its routing")
            wire.a._remove_session(active)
            self.assertNotIn(peer_id, wire.a._derp_candidates)
        finally:
            await wire.close()


    async def test_restart_does_not_revive_forgotten_relay(self):
        wire = _Datagrams()
        try:
            wire.confirm()
            peer_id = wire.b.identity.peer_id
            wire.a._sessions[peer_id].via_relay = True
            wire.a.expect_derp_peer(peer_id)
            wire.a.forget_candidate(peer_id)
            revived = []
            wire.a.expect_derp_peer = lambda peer: revived.append(peer)
            wire.a._started = True
            with patch.object(UdpTransport, "start", _ignore), patch.object(UdpTransport, "stop", _ignore):
                await wire.a.restart()
            self.assertEqual(revived, [])
            self.assertNotIn(peer_id, wire.a._derp_candidates)
        finally:
            await wire.close()

if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main(["-q", "-p", "no:cacheprovider", __file__]))
