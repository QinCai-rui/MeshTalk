"""MeshTalk backend entry point.

Starts LAN discovery, direct peer transports, private rendezvous, storage, and IPC.
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
from .rendezvous import RendezvousService
from .settings import Settings

logger = logging.getLogger("meshtalk")

DATA_DIR = Path.home() / ".meshtalk"


async def main(debug: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    identity = Identity.load_or_generate(DATA_DIR)
    logger.info("Peer ID: %s (%s)", identity.peer_id, identity.display_name)

    db = Database(DATA_DIR / "meshtalk.db")
    await db.connect()
    settings = Settings(DATA_DIR / "settings.json")

    peer_manager = PeerManager(identity, db, on_packet=lambda p, pkt: None)
    router = MessageRouter(identity, peer_manager, db)

    peer_manager.on_packet = router.handle_packet

    async def on_peer_found(peer_id: str, address: str, tcp_port: int) -> None:
        peer_manager.record_lan_candidate(peer_id, address, tcp_port)
        await peer_manager.connect_to_peer(peer_id, address, tcp_port)

    discovery = DiscoveryService(identity.peer_id, 24891, on_peer_found)
    rendezvous = RendezvousService(
        identity, settings, peer_manager.udp, peer_manager.record_remote_candidate
    )

    async def handle_send(req: dict) -> dict:
        recipient = req.get("recipient_id")
        content = req.get("content", "")
        if not recipient:
            return {"error": "recipient_id required"}
        msg_id = await router.send_message(recipient, content.encode())
        return {"message_id": msg_id}

    async def handle_peers(req: dict) -> dict:
        peers = await db.get_all_peers()
        unread_counts = await db.get_unread_counts(identity.peer_id)
        return {"peers": [
            {
                "peer_id": peer["peer_id"],
                "display_name": peer["display_name"],
                "last_seen": peer["last_seen"],
                "is_online": int(peer_manager.get_connected_peer(peer["peer_id"]) is not None),
                "unread_count": unread_counts.get(peer["peer_id"], 0),
                **peer_manager.get_network_info(peer["peer_id"]),
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
            "peers": [
                {
                    "peer_id": peer.peer_id,
                    "display_name": peer.display_name,
                    **peer_manager.get_network_info(peer.peer_id),
                }
                for peer in connected
            ],
            "control_url": settings.control_url or None,
            "control_connected": rendezvous.connected,
            "public_endpoint": (
                f"{rendezvous.public_endpoint[0]}:{rendezvous.public_endpoint[1]}"
                if rendezvous.public_endpoint else None
            ),
            "rooms": rendezvous.room_status(),
        }

    async def handle_messages(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        messages = await db.get_conversation(identity.peer_id, peer_id)
        await db.mark_conversation_read(identity.peer_id, peer_id)
        return {"messages": messages}

    async def handle_set_display_name(req: dict) -> dict:
        display_name = Identity.normalize_display_name(req.get("display_name"))
        identity.display_name = display_name
        identity.save(DATA_DIR)
        await peer_manager.broadcast_profile_update()
        return {"display_name": display_name}

    async def handle_control(req: dict) -> dict:
        url = req.get("url")
        if url is not None:
            if not isinstance(url, str):
                return {"error": "url must be a string"}
            settings.set_control_url(url)
            rendezvous.configuration_changed()
        stun_host, stun_port = settings.stun_server
        return {
            "url": settings.control_url or None,
            "connected": rendezvous.connected,
            "stun_server": f"{stun_host}:{stun_port}",
            "public_endpoint": rendezvous.public_endpoint,
        }

    async def handle_room_create(req: dict) -> dict:
        room = settings.create_room()
        rendezvous.configuration_changed()
        return {"room_id": room.id, "invite": room.invite}

    async def handle_room_join(req: dict) -> dict:
        invite = req.get("invite")
        if not isinstance(invite, str):
            return {"error": "invite required"}
        room = settings.join_room(invite)
        rendezvous.configuration_changed()
        return {"room_id": room.id}

    async def handle_room_leave(req: dict) -> dict:
        room_id = req.get("room_id")
        if not isinstance(room_id, str):
            return {"error": "room_id required"}
        settings.leave_room(room_id)
        rendezvous.configuration_changed()
        return {"room_id": room_id}

    async def handle_rooms(req: dict) -> dict:
        return {"rooms": rendezvous.room_status()}

    ipc_handlers = {
        "send": handle_send,
        "peers": handle_peers,
        "identity": handle_identity,
        "status": handle_status,
        "messages": handle_messages,
        "set_display_name": handle_set_display_name,
        "control": handle_control,
        "room_create": handle_room_create,
        "room_join": handle_room_join,
        "room_leave": handle_room_leave,
        "rooms": handle_rooms,
    }
    ipc = IPCServer(ipc_handlers)
    router.on_received = lambda message: ipc.broadcast_event({"event": "message", **message})
    router.on_delivered = lambda message_id: ipc.broadcast_event({"event": "delivered", "message_id": message_id})

    await peer_manager.start()
    await discovery.start()
    await rendezvous.start()
    await ipc.start()

    logger.info("MeshTalk backend running")

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
    await rendezvous.stop()
    await peer_manager.stop()
    await discovery.stop()
    await db.close()
    logger.info("MeshTalk backend stopped")


def run() -> None:
    debug = "--debug" in sys.argv[1:]
    asyncio.run(main(debug))


if __name__ == "__main__":
    run()
