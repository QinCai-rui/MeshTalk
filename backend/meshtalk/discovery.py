"""LAN UDP peer discovery service.

Broadcasts presence every 3 seconds on UDP port 24890.
Listens for other peers' announcements.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import socket
from typing import Callable, Awaitable

from .protocol import DiscoveryPacket, UDP_PORT

logger = logging.getLogger(__name__)

BROADCAST_INTERVAL = 3.0
BROADCAST_ADDR = "255.255.255.255"
MAX_PENDING_DISCOVERY_PACKETS = 128
DISCOVERY_WORKERS = 4
MAX_KNOWN_ADDRESSES = 512


class DiscoveryService:
    """LAN peer discovery service using UDP broadcast."""

    def __init__(
        self,
        tcp_port: int,
        on_peer_found: Callable[[str, int], Awaitable[None]],
    ) -> None:
        """Initialize discovery service with TCP port and peer found callback."""
        # This identifier is intentionally short-lived and never derived from
        # the signing key, so LAN broadcasts cannot track a peer across runs.
        self.discovery_id = secrets.token_hex(16)
        self.tcp_port = tcp_port
        self.on_peer_found = on_peer_found
        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: DiscoveryProtocol | None = None
        self._running = False
        self._known_addresses: dict[str, tuple[str, int]] = {}
        self._pending: asyncio.Queue[tuple[bytes, tuple[str, int]]] = asyncio.Queue(
            maxsize=MAX_PENDING_DISCOVERY_PACKETS
        )
        self._workers: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        """Start the discovery service and begin broadcasting presence."""
        self._running = True
        loop = asyncio.get_event_loop()
        self._transport, self._protocol = await loop.create_datagram_endpoint(
            lambda: DiscoveryProtocol(self),
            local_addr=("0.0.0.0", UDP_PORT),
        )
        sock = self._transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        logger.info("Discovery started on UDP port %d", UDP_PORT)
        asyncio.create_task(self._broadcast_loop())
        self._workers = [asyncio.create_task(self._discovery_worker()) for _ in range(DISCOVERY_WORKERS)]

    async def stop(self) -> None:
        """Stop the discovery service and clean up resources."""
        self._running = False
        for worker in self._workers:
            worker.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        if self._transport:
            self._transport.close()

    async def _broadcast_loop(self) -> None:
        packet = DiscoveryPacket(
            discovery_id=self.discovery_id,
            tcp_port=self.tcp_port,
        )
        data = packet.encode()
        while self._running:
            try:
                if self._transport:
                    self._transport.sendto(data, (BROADCAST_ADDR, UDP_PORT))
            except Exception as e:
                logger.warning("Broadcast failed: %s", e)
            await asyncio.sleep(BROADCAST_INTERVAL)

    async def handle_discovery(
        self, data: bytes, addr: tuple[str, int]
    ) -> None:
        """Process a received discovery packet and notify callback if it's a new peer."""
        try:
            packet = DiscoveryPacket.decode(data)
        except Exception as e:
            logger.debug("Invalid discovery packet from %s: %s", addr, e)
            return

        if packet.discovery_id == self.discovery_id:
            return

        address = (addr[0], packet.tcp_port)
        if self._known_addresses.get(packet.discovery_id) == address:
            return
        if packet.discovery_id not in self._known_addresses and len(self._known_addresses) >= MAX_KNOWN_ADDRESSES:
            self._known_addresses.pop(next(iter(self._known_addresses)))
        self._known_addresses[packet.discovery_id] = address
        logger.info("Discovered LAN peer at %s:%d", *address)
        await self.on_peer_found(addr[0], packet.tcp_port)

    async def _discovery_worker(self) -> None:
        """Worker task that processes discovery packets from the queue."""
        while self._running:
            data, addr = await self._pending.get()
            try:
                await self.handle_discovery(data, addr)
            finally:
                self._pending.task_done()

    def enqueue_discovery(self, data: bytes, addr: tuple[str, int]) -> None:
        """Add a discovery packet to the processing queue."""
        try:
            self._pending.put_nowait((data, addr))
        except asyncio.QueueFull:
            logger.warning("Dropping discovery packet because the processing queue is full")


class DiscoveryProtocol(asyncio.DatagramProtocol):
    """UDP protocol handler for discovery service."""

    def __init__(self, service: DiscoveryService) -> None:
        """Initialize protocol with reference to discovery service."""
        self.service = service

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        """Called when UDP transport is ready."""
        pass

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        """Handle incoming UDP datagram by enqueuing for processing."""
        self.service.enqueue_discovery(data, addr)

    def error_received(self, exc: Exception) -> None:
        """Handle UDP transport errors."""
        logger.error("Discovery error: %s", exc)
