"""Thin adapter around aioice's TURN allocation transport."""

from __future__ import annotations

import asyncio
import ssl
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import certifi
from aioice.turn import TurnTransport, create_turn_endpoint

Endpoint = tuple[str, int]


@dataclass(frozen=True)
class TurnServer:
    host: str
    port: int
    transport: str
    tls: bool

    @classmethod
    def from_uri(cls, uri: str) -> TurnServer:
        scheme, separator, remainder = uri.partition(":")
        parsed = urlparse(f"//{remainder}") if separator else urlparse(uri)
        if scheme not in {"turn", "turns"} or not parsed.hostname or parsed.path not in {"", "/"}:
            raise ValueError("TURN URI must use turn: or turns:")
        query = parse_qs(parsed.query, strict_parsing=True)
        values = query.get("transport", ["tcp" if scheme == "turns" else "udp"])
        transport = values[0]
        if transport not in {"udp", "tcp"} or len(query) > 1 or len(values) != 1:
            raise ValueError("TURN URI transport must be udp or tcp")
        if scheme == "turns" and transport != "tcp":
            raise ValueError("turns: requires TCP transport")
        return cls(parsed.hostname, parsed.port or (5349 if scheme == "turns" else 3478), transport, scheme == "turns")


class _RelayProtocol(asyncio.DatagramProtocol):
    def __init__(self, received: Callable[[bytes, Endpoint], None]) -> None:
        self.received = received
        self.closed = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr: Endpoint) -> None:
        self.received(data, (str(addr[0]), int(addr[1])))

    def connection_lost(self, exc: Exception | None) -> None:
        if not self.closed.done():
            self.closed.set_result(exc)


class TurnRelay:
    """One relayed UDP allocation, regardless of its TURN server transport."""

    def __init__(self, server: TurnServer, received: Callable[[bytes, Endpoint], None]) -> None:
        self.server = server
        self.received = received
        self.transport: TurnTransport | None = None
        self.protocol: _RelayProtocol | None = None

    @property
    def endpoint(self) -> Endpoint:
        if self.transport is None:
            raise RuntimeError("TURN allocation is not active")
        host, port = self.transport.get_extra_info("sockname")[:2]
        return str(host), int(port)

    async def start(self, username: str, credential: str) -> None:
        context = ssl.create_default_context(cafile=certifi.where()) if self.server.tls else None
        transport, protocol = await create_turn_endpoint(
            lambda: _RelayProtocol(self.received),
            (self.server.host, self.server.port),
            username,
            credential,
            transport=self.server.transport,
            ssl=context,
        )
        self.transport, self.protocol = transport, protocol

    def sendto(self, data: bytes, endpoint: Endpoint) -> None:
        if self.transport is None:
            raise ConnectionError("TURN allocation is not active")
        self.transport.sendto(data, endpoint)

    async def stop(self) -> None:
        if self.transport is not None:
            self.transport.close()
        if self.protocol is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self.protocol.closed), 2)
            except TimeoutError:
                pass
        self.transport = None
        self.protocol = None
