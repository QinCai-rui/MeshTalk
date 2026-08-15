import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from meshtalk import ipc


class IPCServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_socket_path = ipc.IPC_SOCKET_PATH
        ipc.IPC_SOCKET_PATH = Path(self.tempdir.name) / "meshtalk.sock"

        async def send_handler(request: dict) -> dict:
            return {"content_length": len(request["content"])}

        self.server = ipc.IPCServer({"send": send_handler})
        await self.server.start()

    async def asyncTearDown(self):
        await self.server.stop()
        ipc.IPC_SOCKET_PATH = self.original_socket_path
        self.tempdir.cleanup()

    async def test_accepts_framed_maximum_size_message(self):
        reader, writer = await asyncio.open_unix_connection(str(ipc.IPC_SOCKET_PATH))
        content = "x" * (64 * 1024)
        writer.write((json.dumps({"id": 1, "action": "send", "content": content}) + "\n").encode())
        await writer.drain()

        response = json.loads((await asyncio.wait_for(reader.readline(), 1)).decode())
        self.assertEqual(response, {"id": 1, "content_length": len(content)})

        writer.close()
        await writer.wait_closed()
