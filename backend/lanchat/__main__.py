"""LanChat backend entry point.

Starts all services: identity, database, discovery, TCP server, IPC.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from pathlib import Path

from .identity import Identity
from .database import Database
from .discovery import DiscoveryService
from .peer_manager import PeerManager, PeerConnection
from .message_router import MessageRouter
from .ipc import IPCServer
from .protocol import Packet, PacketType

logger = logging.getLogger("lanchat")

DATA_DIR = Path.home() / ".lanchat"


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    identity = Identity.load_or_generate(DATA_DIR)
    logger.info("Peer ID: %s (%s)", identity.peer_id, identity.display_name)

    db = Database(DATA_DIR / "lanchat.db")
    await db.connect()

    peer_manager = PeerManager(identity, db, on_packet=lambda p, pkt: None)
    router = MessageRouter(identity, peer_manager, db)

    peer_manager.on_packet = router.handle_packet

    async def on_peer_found(peer_id: str, address: str, tcp_port: int) -> None:
        await peer_manager.connect_to_peer(peer_id, address, tcp_port)

    discovery = DiscoveryService(identity.peer_id, 24891, on_peer_found)

    async def handle_send(req: dict) -> dict:
        recipient = req.get("recipient_id")
        content = req.get("content", "")
        if not recipient:
            return {"error": "recipient_id required"}
        msg_id = await router.send_message(recipient, content.encode())
        return {"message_id": msg_id}

    async def handle_peers(req: dict) -> dict:
        peers = await db.get_all_peers()
        return {"peers": [
            {
                "peer_id": peer["peer_id"],
                "display_name": peer["display_name"],
                "last_seen": peer["last_seen"],
                "is_online": peer["is_online"],
            }
            for peer in peers
        ]}

    async def handle_identity(req: dict) -> dict:
        return {
            "peer_id": identity.peer_id,
            "display_name": identity.display_name,
        }

    async def handle_status(req: dict) -> dict:
        connected = peer_manager.get_connected_peers()
        return {
            "peer_id": identity.peer_id,
            "connected_peers": len(connected),
            "peers": [{"peer_id": p.peer_id, "display_name": p.display_name} for p in connected],
        }

    async def handle_messages(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        return {"messages": await db.get_conversation(identity.peer_id, peer_id)}

    ipc_handlers = {
        "send": handle_send,
        "peers": handle_peers,
        "identity": handle_identity,
        "status": handle_status,
        "messages": handle_messages,
    }
    ipc = IPCServer(ipc_handlers)
    router.on_received = lambda message: ipc.broadcast_event({"event": "message", **message})

    await discovery.start()
    await peer_manager.start()
    await ipc.start()

    logger.info("LanChat backend running")

    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    async def periodic_cleanup() -> None:
        while True:
            await asyncio.sleep(300)
            await db.cleanup_expired()

    asyncio.create_task(periodic_cleanup())

    await stop_event.wait()

    await ipc.stop()
    await peer_manager.stop()
    await discovery.stop()
    await db.close()
    logger.info("LanChat backend stopped")


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
