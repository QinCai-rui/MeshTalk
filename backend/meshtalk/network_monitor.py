"""Detect changes to the host's active network path.

The backend deliberately does not depend on a platform-specific network
notification library.  A small polling loop is reliable on the platforms we
support and, unlike a notification for a single interface, also catches a
default-route change when an interface remains up.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
import sys
from dataclasses import dataclass
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

NETWORK_POLL_INTERVAL = 5.0
NETWORK_PROBE_PORT = 53


@dataclass(frozen=True)
class NetworkState:
    """The network properties that affect advertised and connected peers."""

    gateway: str | None
    local_ip: str | None


def _default_gateway() -> str | None:
    """Return the IPv4 default gateway, if one is currently configured."""
    if sys.platform == "darwin":
        command = ["route", "-n", "get", "default"]
    elif sys.platform == "win32":
        command = ["route", "print", "-4", "0.0.0.0"]
    else:
        # Linux exposes this without requiring a subprocess.  The gateway is
        # stored as a little-endian hexadecimal IPv4 value.
        try:
            with open("/proc/net/route", encoding="ascii") as routes:
                for line in routes:
                    fields = line.split()
                    if len(fields) >= 3 and fields[1] == "00000000" and fields[2] != "00000000":
                        raw = bytes.fromhex(fields[2])
                        return socket.inet_ntoa(raw[::-1])
        except (FileNotFoundError, OSError, ValueError):
            pass
        command = ["route", "-n", "get", "default"]

    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        fields = line.split()
        if sys.platform == "win32":
            # route print includes: 0.0.0.0  0.0.0.0  <gateway> ...
            if len(fields) >= 3 and fields[0] == "0.0.0.0" and fields[1] == "0.0.0.0":
                try:
                    socket.inet_aton(fields[2])
                except OSError:
                    continue
                return fields[2]
        elif fields and fields[0].lower().rstrip(":") == "gateway" and len(fields) >= 2:
            try:
                socket.inet_aton(fields[1])
            except OSError:
                continue
            return fields[1]
    return None


def _local_ip(gateway: str | None) -> str | None:
    """Find the source IPv4 address selected for the active network path."""
    target = gateway or "8.8.8.8"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(1)
        sock.connect((target, NETWORK_PROBE_PORT))
        address = sock.getsockname()[0]
        return address if address and not address.startswith("127.") else None
    except OSError:
        return None
    finally:
        sock.close()


def current_network_state() -> NetworkState:
    """Take a best-effort snapshot of the current network path."""
    gateway = _default_gateway()
    return NetworkState(gateway, _local_ip(gateway))


class NetworkMonitor:
    """Poll network state and notify the backend after a meaningful change."""

    def __init__(
        self,
        on_change: Callable[[NetworkState, NetworkState], Awaitable[None]],
        interval: float = NETWORK_POLL_INTERVAL,
        state_provider: Callable[[], NetworkState] = current_network_state,
    ) -> None:
        self.on_change = on_change
        self.interval = interval
        self.state_provider = state_provider
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._state: NetworkState | None = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        try:
            self._state = await asyncio.to_thread(self.state_provider)
        except Exception:
            self._running = False
            raise
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def poll_once(self) -> bool:
        """Poll once; return whether a change callback was invoked."""
        current = await asyncio.to_thread(self.state_provider)
        previous = self._state
        self._state = current
        if previous is None or previous == current:
            return False
        logger.info(
            "Network path changed: gateway %s -> %s, local IP %s -> %s",
            previous.gateway,
            current.gateway,
            previous.local_ip,
            current.local_ip,
        )
        await self.on_change(previous, current)
        return True

    async def _run(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.interval)
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Network state polling failed")
