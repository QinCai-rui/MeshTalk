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
from .friends import FriendManager
from .group_router import GroupRouter
from .message_router import MessageRouter
from .ipc import IPCServer
from .protocol import PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, Packet, PacketType
from .rendezvous import RendezvousService
from .settings import Settings

logger = logging.getLogger("meshtalk")

DATA_DIR = Path.home() / ".meshtalk"


async def main(debug: bool = False, exit_when_detached: bool = False) -> None:
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
    friend_manager = FriendManager(identity, peer_manager, db)
    group_router = GroupRouter(identity, peer_manager, db, settings)
    router = MessageRouter(
        identity, peer_manager, db, friend_manager=friend_manager, group_router=group_router
    )
    tui_clients: set[str] = set()

    peer_manager.on_packet = router.handle_packet

    async def flush_outgoing(peer_id: str) -> None:
        peer = peer_manager.get_connected_peer(peer_id)
        if peer is None:
            return
        items = await db.get_pending_outgoing(peer_id)
        if not items:
            return
        for item in items:
            if peer.is_quarantined:
                if item["message_id"] and item.get("group_id"):
                    await db.set_group_delivery(item["message_id"], peer_id, "unavailable")
                elif item["message_id"]:
                    await db.mark_message_failed(item["message_id"])
                    await ipc.broadcast_event({"event": "message_failed", "message_id": item["message_id"]})
                await db.remove_from_outqueue(item["id"])
                continue
            if not await group_router.can_flush(peer, item):
                if item["message_id"] and item.get("group_id"):
                    await db.set_group_delivery(item["message_id"], peer_id, "unavailable")
                await db.remove_from_outqueue(item["id"])
                continue
            try:
                packet = Packet(PacketType(item["packet_type"]), item["encrypted_payload"])
                if item["message_id"] and item.get("group_id"):
                    await db.set_group_delivery(item["message_id"], peer_id, "sent")
                await peer_manager.send_packet(peer, packet)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to flush queued packet for %s: %s", peer_id, exc)
                await db.increment_outqueue_attempts(item["id"])
                continue
            if item["message_id"] and item.get("group_id"):
                await ipc.broadcast_event({
                    "event": "group_sent",
                    "message_id": item["message_id"],
                    "group_id": item["group_id"],
                    "recipient_id": peer_id,
                })
            elif item["message_id"]:
                await db.mark_message_sent(item["message_id"])
                await ipc.broadcast_event({
                    "event": "message_sent",
                    "message_id": item["message_id"],
                    "peer_id": peer_id,
                })
            await db.remove_from_outqueue(item["id"])
        logger.info("Flushed %d queued item(s) to %s", len(items), peer_id)

    async def handle_peer_changed(peer_id: str) -> None:
        event = {"event": "peer_update", "peer_id": peer_id}
        peer = peer_manager.get_connected_peer(peer_id)
        if peer is not None:
            event.update(peer.negotiated())
        await ipc.broadcast_event(event)
        if peer is not None:
            await group_router.peer_connected(peer_id)
            await flush_outgoing(peer_id)

    peer_manager.on_peer_changed = handle_peer_changed

    async def handle_version_mismatch(peer_id: str, remote_version: int, remote_min: int) -> None:
        await ipc.broadcast_event({
            "event": "peer_version_mismatch",
            "peer_id": peer_id,
            "remote_version": remote_version,
            "remote_min_version": remote_min,
            "local_version": PROTOCOL_VERSION,
            "local_min_version": MIN_SUPPORTED_PROTOCOL_VERSION,
            "error": f"Incompatible protocol version for peer {peer_id}: remote (v{remote_version}, min v{remote_min}) vs local (v{PROTOCOL_VERSION}, min v{MIN_SUPPORTED_PROTOCOL_VERSION})",
        })

    peer_manager.on_version_mismatch = handle_version_mismatch

    async def on_peer_found(address: str, tcp_port: int) -> None:
        await peer_manager.connect_to_peer(None, address, tcp_port)

    discovery = DiscoveryService(24891, on_peer_found)
    rendezvous = RendezvousService(
        identity,
        settings,
        peer_manager.udp,
        peer_manager.record_remote_candidate,
        group_router.record_room_member,
    )

    async def handle_send(req: dict) -> dict:
        recipient = req.get("recipient_id")
        content = req.get("content", "")
        if not recipient:
            return {"error": "recipient_id required"}
        msg_id, queued = await router.send_message(recipient, content.encode())
        return {"message_id": msg_id, "queued": queued}

    def _peer_delivery_warnings(
        connection: object | None,
        is_friend: bool,
        active_transport: str | None,
        control_connected: bool,
    ) -> list[str]:
        """Authoritative per-peer messaging limitations.

        The TUI renders these directly instead of re-deriving the rules
        client-side, so the displayed warnings cannot drift from the
        backend's actual policy.
        """
        if connection is None:
            return ["offline"]
        warnings = []
        if not is_friend:
            warnings.append("not_friend")
        if active_transport == "remote_udp" and not control_connected:
            warnings.append("rendezvous_out_of_sync")
        if getattr(connection, "version_mismatch", None):
            warnings.append("incompatible")
        return warnings

    async def handle_peers(req: dict) -> dict:
        peers = await db.get_all_peers()
        unread_counts = await db.get_unread_counts(identity.peer_id)
        friends = {peer["peer_id"] for peer in await db.get_friends()}
        blocked = {peer["peer_id"] for peer in await db.get_blocked_peers()}
        friend_requests: dict[str, str] = {}
        for request in await db.get_pending_friend_requests():
            direction = request["direction"]
            other_party = request["recipient_id"] if direction == "outgoing" else request["sender_id"]
            if not other_party:
                continue
            previous = friend_requests.get(other_party)
            if previous is None:
                friend_requests[other_party] = direction
            elif previous != direction:
                friend_requests[other_party] = "both"
        return {"peers": [
            {
                "peer_id": peer["peer_id"],
                "display_name": peer["display_name"],
                "last_seen": peer["last_seen"],
                "is_online": int((connection := peer_manager.get_connected_peer(peer["peer_id"])) is not None),
                "presence": "active" if connection and connection.tui_active else "away" if connection else "offline",
                "unread_count": unread_counts.get(peer["peer_id"], 0),
                "is_friend": peer["peer_id"] in friends,
                "is_blocked": peer["peer_id"] in blocked,
                "friend_request": friend_requests.get(peer["peer_id"]),
                "protocol_version": connection.protocol_version if connection else None,
                "remote_protocol_version": connection.remote_protocol_version if connection else None,
                "version_mismatch": connection.version_mismatch if connection else None,
                "delivery_warnings": _peer_delivery_warnings(
                    connection,
                    peer["peer_id"] in friends,
                    (network_info := peer_manager.get_network_info(peer["peer_id"])).get("active_transport"),
                    rendezvous.connected,
                ),
                "capabilities": list(connection.capabilities) if connection else [],
                **network_info,
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

    async def handle_friend_send(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        note = req.get("note", "")
        if note is not None and not isinstance(note, str):
            return {"error": "note must be a string"}
        request_id = await friend_manager.send_friend_request(peer_id, note or "")
        return {"request_id": request_id}

    async def handle_friend_respond(req: dict) -> dict:
        request_id = req.get("request_id")
        accept = req.get("accept")
        if not isinstance(request_id, str) or not request_id:
            return {"error": "request_id required"}
        if not isinstance(accept, bool):
            return {"error": "accept must be boolean"}
        await friend_manager.respond_to_friend_request(request_id, accept)
        return {"request_id": request_id, "accepted": accept}

    async def handle_friend_cancel(req: dict) -> dict:
        request_id = req.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            return {"error": "request_id required"}
        await friend_manager.cancel_friend_request(request_id)
        return {"request_id": request_id}

    async def handle_unfriend(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        await friend_manager.unfriend(peer_id)
        return {"peer_id": peer_id}

    async def handle_friends(req: dict) -> dict:
        return {"friends": await db.get_friends()}

    async def handle_friend_requests(req: dict) -> dict:
        return {"requests": await db.get_pending_friend_requests()}

    async def handle_block_peer(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        await friend_manager.block_peer(peer_id)
        return {"peer_id": peer_id}

    async def handle_unblock_peer(req: dict) -> dict:
        peer_id = req.get("peer_id")
        if not isinstance(peer_id, str) or not peer_id:
            return {"error": "peer_id required"}
        await friend_manager.unblock_peer(peer_id)
        return {"peer_id": peer_id}

    async def handle_blocked_peers(req: dict) -> dict:
        return {"blocked": await db.get_blocked_peers()}

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

    async def handle_detached() -> None:
        logger.info("IPC detachment detected; stopping backend")
        stop_event.set()

    async def handle_identity(req: dict) -> dict:
        return {
            "peer_id": identity.peer_id,
            "display_name": identity.display_name,
            "setup_dismissed": settings.identity_setup_dismissed or identity.display_name != "Anonymous",
        }

    async def handle_status(req: dict) -> dict:
        connected = peer_manager.get_connected_peers()
        friends = {peer["peer_id"] for peer in await db.get_friends()}
        return {
            "peer_id": identity.peer_id,
            "connected_peers": len(connected),
            "peers": [
                {
                    "peer_id": peer.peer_id,
                    "display_name": peer.display_name,
                    "is_online": 1,
                    "protocol_version": peer.protocol_version,
                    "remote_protocol_version": peer.remote_protocol_version,
                    "version_mismatch": peer.version_mismatch,
                    "delivery_warnings": _peer_delivery_warnings(
                        peer,
                        peer.peer_id in friends,
                        (network_info := peer_manager.get_network_info(peer.peer_id)).get("active_transport"),
                        rendezvous.connected,
                    ),
                    "capabilities": list(peer.capabilities),
                    **network_info,
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
        name = req.get("name")
        if name is not None and not isinstance(name, str):
            return {"error": "name must be a string"}
        room = settings.create_room(name)
        await group_router.sync_groups()
        if room.group_name:
            await group_router.record_local_join(room.id)
        rendezvous.configuration_changed()
        return {
            "room_id": room.id,
            "group_id": room.id if room.group_name else None,
            "name": room.group_name,
            "invite": room.invite,
        }

    async def handle_room_join(req: dict) -> dict:
        invite = req.get("invite")
        if not isinstance(invite, str):
            return {"error": "invite required"}
        room = settings.join_room(invite)
        await group_router.sync_groups()
        if room.group_name:
            await group_router.record_local_join(room.id)
        rendezvous.configuration_changed()
        return {"room_id": room.id, "group_id": room.id if room.group_name else None, "name": room.group_name}

    async def handle_room_leave(req: dict) -> dict:
        room_id = req.get("room_id")
        if not isinstance(room_id, str):
            return {"error": "room_id required"}
        room = settings.rooms.get(room_id)
        if room and room.group_name is not None:
            return {"error": "Use group_leave for a room-backed group"}
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

    async def handle_groups(req: dict) -> dict:
        return {"groups": await db.get_groups(identity.peer_id)}

    async def handle_group_members(req: dict) -> dict:
        group_id = req.get("group_id")
        if not isinstance(group_id, str) or group_id not in settings.rooms:
            return {"error": "valid group_id required"}
        members = await db.get_group_members(group_id)
        for member in members:
            connection = peer_manager.get_connected_peer(member["peer_id"])
            member["is_online"] = member["peer_id"] == identity.peer_id or connection is not None
            member["is_incompatible"] = bool(connection and connection.version_mismatch)
            member["show_in_sidebar"] = (
                member["is_online"] or time.time() - member["last_seen"] <= 24 * 60 * 60
            )
        return {"members": members}

    async def handle_group_messages(req: dict) -> dict:
        group_id = req.get("group_id")
        if not isinstance(group_id, str) or group_id not in settings.rooms:
            return {"error": "valid group_id required"}
        messages = await db.get_group_messages(group_id)
        await db.mark_group_read(group_id)
        return {"messages": messages}

    async def handle_group_send(req: dict) -> dict:
        group_id = req.get("group_id")
        content = req.get("content")
        if not isinstance(group_id, str) or not isinstance(content, str):
            return {"error": "group_id and content required"}
        message_id, deliveries = await group_router.send_message(group_id, content.encode())
        return {"message_id": message_id, "deliveries": deliveries}

    async def handle_group_leave(req: dict) -> dict:
        group_id = req.get("group_id")
        if not isinstance(group_id, str):
            return {"error": "group_id required"}
        await group_router.leave_group(group_id)
        rendezvous.configuration_changed()
        return {"group_id": group_id}

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

    async def handle_debug_re_stun(req: dict) -> dict:
        return await rendezvous.refresh_endpoint()

    async def handle_debug_info(req: dict) -> dict:
        stun_host, stun_port = settings.stun_server
        peers_info = []
        for peer in await db.get_all_peers():
            info = peer_manager.get_network_info(peer["peer_id"])
            connection = peer_manager.get_connected_peer(peer["peer_id"])
            peers_info.append({
                "peer_id": peer["peer_id"],
                "display_name": peer["display_name"],
                "is_online": connection is not None,
                "protocol_version": connection.protocol_version if connection else None,
                "remote_protocol_version": connection.remote_protocol_version if connection else None,
                "capabilities": list(connection.capabilities) if connection else [],
                **info,
            })
        return {
            "public_endpoint": list(rendezvous.public_endpoint) if rendezvous.public_endpoint else None,
            "stun_server": f"{stun_host}:{stun_port}",
            "local_tcp_port": peer_manager.tcp_port,
            "rooms": rendezvous.room_status(),
            "peers": peers_info,
        }

    ipc_handlers = {
        "send": handle_send,
        "peers": handle_peers,
        "remove_peer": handle_remove_peer,
        "friend_send": handle_friend_send,
        "friend_respond": handle_friend_respond,
        "friend_cancel": handle_friend_cancel,
        "unfriend": handle_unfriend,
        "friends": handle_friends,
        "friend_requests": handle_friend_requests,
        "block_peer": handle_block_peer,
        "unblock_peer": handle_unblock_peer,
        "blocked_peers": handle_blocked_peers,
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
        "groups": handle_groups,
        "group_members": handle_group_members,
        "group_messages": handle_group_messages,
        "group_send": handle_group_send,
        "group_leave": handle_group_leave,
        "mute": handle_mute,
        "unmute": handle_unmute,
        "muted_peers": handle_muted_peers,
        "debug_re_stun": handle_debug_re_stun,
        "debug_info": handle_debug_info,
        "shutdown": handle_shutdown,
    }
    ipc = IPCServer(
        ipc_handlers,
        on_tui_disconnect=handle_tui_disconnect,
        on_detached=handle_detached if exit_when_detached else None,
        exit_when_detached=exit_when_detached,
    )
    router.on_received = lambda message: ipc.broadcast_event({"event": "message", **message})
    router.on_delivered = lambda message_id: ipc.broadcast_event({"event": "delivered", "message_id": message_id})
    group_router.on_event = ipc.broadcast_event
    friend_manager.on_friend_request = lambda event: ipc.broadcast_event({"event": "friend_request", **event})
    friend_manager.on_friend_response = lambda event: ipc.broadcast_event({"event": "friend_response", **event})
    friend_manager.on_friend_cancelled = lambda event: ipc.broadcast_event({"event": "friend_cancelled", **event})
    friend_manager.on_message_blocked = lambda event: ipc.broadcast_event({"event": "message_blocked", **event})

    await peer_manager.start()
    await peer_manager.load_endpoints()
    await group_router.sync_groups()
    await discovery.start()
    await rendezvous.start()
    await ipc.start()

    logger.info(
        "MeshTalk backend running%s",
        " (exits when IPC detaches)" if exit_when_detached else "",
    )

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
    exit_when_detached = "--exit-when-detached" in sys.argv[1:]
    asyncio.run(main(debug, exit_when_detached))


if __name__ == "__main__":
    run()
