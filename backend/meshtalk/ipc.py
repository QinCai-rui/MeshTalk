"""IPC server over Unix domain socket or TCP.

Provides a JSON-based protocol for TUI/CLI to communicate with the backend.
Uses Unix domain sockets on Linux/macOS and TCP on Windows.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

DATA_DIR = Path.home() / ".meshtalk"
IPC_SOCKET_PATH = DATA_DIR / "meshtalk.sock"
IPC_PORT_PATH = DATA_DIR / "meshtalk.port"
MAX_IPC_LINE_SIZE = 256 * 1024


def _unix_sockets_supported() -> bool:
    if sys.platform == "win32":
        return hasattr(asyncio, "start_unix_server")
    return True


class IPCServer:
    def __init__(
        self,
        handlers: dict[str, Callable[[dict], Awaitable[dict]]],
    ) -> None:
        self.handlers = handlers
        self._server: asyncio.Server | None = None
        self._clients: list[asyncio.StreamWriter] = []
        self._use_tcp = False

    async def start(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        if _unix_sockets_supported():
            if IPC_SOCKET_PATH.exists():
                IPC_SOCKET_PATH.unlink()
            try:
                self._server = await asyncio.start_unix_server(
                    self._handle_client, path=str(IPC_SOCKET_PATH), limit=MAX_IPC_LINE_SIZE
                )
                os.chmod(str(IPC_SOCKET_PATH), 0o600)
                logger.info("IPC server listening on %s", IPC_SOCKET_PATH)
                return
            except (NotImplementedError, OSError) as exc:
                logger.warning("Unix socket unavailable (%s), falling back to TCP", exc)

        self._use_tcp = True
        self._server = await asyncio.start_server(
            self._handle_client, "127.0.0.1", 0, limit=MAX_IPC_LINE_SIZE
        )
        port = self._server.sockets[0].getsockname()[1]
        IPC_PORT_PATH.write_text(str(port))
        os.chmod(str(IPC_PORT_PATH), 0o600)
        logger.info("IPC server listening on TCP 127.0.0.1:%d", port)

    async def stop(self) -> None:
        for writer in self._clients:
            writer.close()
        if self._server:
            self._server.close()
        if IPC_SOCKET_PATH.exists():
            IPC_SOCKET_PATH.unlink()
        if IPC_PORT_PATH.exists():
            IPC_PORT_PATH.unlink()

    async def broadcast_event(self, event: dict) -> None:
        """Send an event to all connected clients."""
        data = json.dumps(event) + "\n"
        dead = []
        for writer in self._clients:
            try:
                writer.write(data.encode())
                await writer.drain()
            except Exception:
                dead.append(writer)
        for w in dead:
            self._clients.remove(w)

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._clients.append(writer)
        logger.info("IPC client connected")
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                request = {}
                try:
                    request = json.loads(line.decode())
                    response = await self._dispatch(request)
                except Exception as e:
                    response = {"error": str(e)}
                if "id" in request:
                    response["id"] = request["id"]
                writer.write((json.dumps(response) + "\n").encode())
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except ValueError as exc:
            logger.warning("IPC client sent an oversized request: %s", exc)
        finally:
            if writer in self._clients:
                self._clients.remove(writer)
            writer.close()
            logger.info("IPC client disconnected")

    async def _dispatch(self, request: dict) -> dict:
        action = request.get("action")
        if action not in self.handlers:
            return {"error": f"Unknown action: {action}"}
        try:
            return await self.handlers[action](request)
        except Exception as e:
            return {"error": str(e)}
