"""MeshTalk backend entry point.

Starts LAN discovery, direct peer transports, private rendezvous, storage, and IPC.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
import time
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
    stop_event = asyncio.Event()

    db = Database(DATA_DIR / "meshtalk.db", identity.storage_key())
    await db.connect()
    settings = Settings(DATA_DIR / "settings.json")

    peer_manager = PeerManager(identity, db, on_packet=lambda p, pkt: None)
    router = MessageRouter(identity, peer_manager, db)
    tui_clients: set[str] = set()

    peer_manager.on_packet = router.handle_packet

    async def on_peer_found(address: str, tcp_port: int) -> None:
        await peer_manager.connect_to_peer(None, address, tcp_port)

    discovery = DiscoveryService(24891, on_peer_found)
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
                "is_online": int((connection := peer_manager.get_connected_peer(peer["peer_id"])) is not None),
                "presence": "active" if connection and connection.tui_active else "away" if connection else "offline",
                "unread_count": unread_counts.get(peer["peer_id"], 0),
                **peer_manager.get_network_info(peer["peer_id"]),
            }
            for peer in peers
        ]}

    async def handle_remove_peer(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        if peer_manager.get_connected_peer(peer_id):
            return {"error": "Cannot remove a connected peer"}
        await db.remove_peer(peer_id)
        return {"peer_id": peer_id}

    async def update_tui_presence(client_id: str, active: bool) -> None:
        was_active = bool(tui_clients)
        if active:
            tui_clients.add(client_id)
        else:
            tui_clients.discard(client_id)
        if was_active != bool(tui_clients):
            await peer_manager.set_tui_active(bool(tui_clients))

    async def handle_tui_presence(req: dict) -> dict:
        client_id = req.get("client_id")
        active = req.get("active")
        if not isinstance(client_id, str) or not client_id or len(client_id) > 128:
            return {"error": "valid client_id required"}
        if not isinstance(active, bool):
            return {"error": "active must be boolean"}
        await update_tui_presence(client_id, active)
        return {"active": bool(tui_clients)}

    async def handle_tui_disconnect(client_id: str) -> None:
        await update_tui_presence(client_id, False)

    async def handle_identity(req: dict) -> dict:
        return {
            "peer_id": identity.peer_id,
            "display_name": identity.display_name,
            "setup_dismissed": settings.identity_setup_dismissed or identity.display_name != "Anonymous",
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
                    "is_online": 1,
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
        settings.dismiss_identity_setup()
        await peer_manager.broadcast_profile_update()
        return {"display_name": display_name}

    async def handle_control(req: dict) -> dict:
        url = req.get("url")
        if url is not None:
            if not isinstance(url, str):
                return {"error": "url must be a string"}
            settings.set_control_url(url)
            rendezvous.configuration_changed()
        if req.get("dismiss_setup") is True:
            settings.dismiss_control_setup()
        stun_host, stun_port = settings.stun_server
        return {
            "url": settings.control_url or None,
            "connected": rendezvous.connected,
            "setup_dismissed": settings.control_setup_dismissed,
            "stun_server": f"{stun_host}:{stun_port}",
            "public_endpoint": rendezvous.public_endpoint,
            "reconnect_attempts": rendezvous.reconnect_attempts,
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

    async def handle_room_invite(req: dict) -> dict:
        room_id = req.get("room_id")
        room = settings.rooms.get(room_id) if isinstance(room_id, str) else None
        if not room:
            return {"error": "Unknown room ID"}
        return {"room_id": room.id, "invite": room.invite}

    async def handle_rooms(req: dict) -> dict:
        return {"rooms": rendezvous.room_status()}

    async def handle_mute(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        timeout = req.get("timeout")
        if timeout is not None and not isinstance(timeout, (int, float)):
            return {"error": "timeout must be a number (seconds) or 0 for permanent"}
        if timeout is None:
            timeout = 0
        until = time.time() + float(timeout) if float(timeout) > 0 else 0
        settings.mute_peer(peer_id, until)
        return {"peer_id": peer_id, "until": until}

    async def handle_unmute(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        settings.unmute_peer(peer_id)
        return {"peer_id": peer_id}

    async def handle_muted_peers(req: dict) -> dict:
        now = time.time()
        muted = {}
        for peer_id, until in settings.muted_peers.items():
            if until <= 0 or now < until:
                muted[peer_id] = until
        return {"muted_peers": muted}

    async def handle_shutdown(req: dict) -> dict:
        stop_event.set()
        return {"stopping": True}

    ipc_handlers = {
        "send": handle_send,
        "peers": handle_peers,
        "remove_peer": handle_remove_peer,
        "tui_presence": handle_tui_presence,
        "identity": handle_identity,
        "status": handle_status,
        "messages": handle_messages,
        "set_display_name": handle_set_display_name,
        "control": handle_control,
        "room_create": handle_room_create,
        "room_join": handle_room_join,
        "room_leave": handle_room_leave,
        "room_invite": handle_room_invite,
        "rooms": handle_rooms,
        "mute": handle_mute,
        "unmute": handle_unmute,
        "muted_peers": handle_muted_peers,
        "shutdown": handle_shutdown,
    }
    ipc = IPCServer(ipc_handlers, on_tui_disconnect=handle_tui_disconnect)
    router.on_received = lambda message: ipc.broadcast_event({"event": "message", **message})
    router.on_delivered = lambda message_id: ipc.broadcast_event({"event": "delivered", "message_id": message_id})

    await peer_manager.start()
    await peer_manager.load_endpoints()
    await discovery.start()
    await rendezvous.start()
    await ipc.start()

    logger.info("MeshTalk backend running")

    def _signal_handler() -> None:
        stop_event.set()

    if sys.platform != "win32":
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _signal_handler)
    else:
        signal.signal(signal.SIGINT, lambda *_: _signal_handler())
        signal.signal(signal.SIGTERM, lambda *_: _signal_handler())

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
