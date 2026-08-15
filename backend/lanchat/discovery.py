"""UDP peer discovery service.

Broadcasts presence every 3 seconds on UDP port 24890.
Listens for other peers' announcements.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from typing import Callable, Awaitable

from .protocol import DiscoveryPacket, UDP_PORT, PROTOCOL_VERSION

logger = logging.getLogger(__name__)

BROADCAST_INTERVAL = 3.0
BROADCAST_ADDR = "255.255.255.255"


class DiscoveryService:
    def __init__(
        self,
        peer_id: str,
        tcp_port: int,
        on_peer_found: Callable[[str, str, int], Awaitable[None]],
    ) -> None:
        self.peer_id = peer_id
        self.tcp_port = tcp_port
        self.on_peer_found = on_peer_found
        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: DiscoveryProtocol | None = None
        self._running = False

    async def start(self) -> None:
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

    async def stop(self) -> None:
        self._running = False
        if self._transport:
            self._transport.close()

    async def _broadcast_loop(self) -> None:
        packet = DiscoveryPacket(
            protocol=PROTOCOL_VERSION,
            peer_id=self.peer_id,
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
        try:
            packet = DiscoveryPacket.decode(data)
        except Exception as e:
            logger.debug("Invalid discovery packet from %s: %s", addr, e)
            return

        if packet.peer_id == self.peer_id:
            return

        if packet.protocol != PROTOCOL_VERSION:
            logger.debug("Unknown protocol version from %s", packet.peer_id)
            return

        logger.info("Discovered peer %s at %s:%d", packet.peer_id, addr[0], packet.tcp_port)
        await self.on_peer_found(packet.peer_id, addr[0], packet.tcp_port)


class DiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self, service: DiscoveryService) -> None:
        self.service = service

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        pass

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        asyncio.create_task(self.service.handle_discovery(data, addr))

    def error_received(self, exc: Exception) -> None:
        logger.error("Discovery error: %s", exc)
