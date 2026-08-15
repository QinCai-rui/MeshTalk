"""IPC server over Unix domain socket.

Provides a JSON-based protocol for TUI/CLI to communicate with the backend.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

IPC_SOCKET_PATH = Path.home() / ".lanchat" / "lanchat.sock"
MAX_IPC_LINE_SIZE = 256 * 1024


class IPCServer:
    def __init__(
        self,
        handlers: dict[str, Callable[[dict], Awaitable[dict]]],
    ) -> None:
        self.handlers = handlers
        self._server: asyncio.Server | None = None
        self._clients: list[asyncio.StreamWriter] = []

    async def start(self) -> None:
        IPC_SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
        if IPC_SOCKET_PATH.exists():
            IPC_SOCKET_PATH.unlink()

        self._server = await asyncio.start_unix_server(
            self._handle_client, str(IPC_SOCKET_PATH), limit=MAX_IPC_LINE_SIZE
        )
        os.chmod(str(IPC_SOCKET_PATH), 0o600)
        logger.info("IPC server listening on %s", IPC_SOCKET_PATH)

    async def stop(self) -> None:
        for writer in self._clients:
            writer.close()
        if self._server:
            self._server.close()
        if IPC_SOCKET_PATH.exists():
            IPC_SOCKET_PATH.unlink()

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
