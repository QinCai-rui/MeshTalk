"""MeshTalk backend entry point.

Starts LAN discovery, direct peer transports, private rendezvous, storage, and IPC.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from .identity import Identity
from .database import Database
from .discovery import DiscoveryService
from .peer_manager import PeerManager, PeerConnection
from .friends import FriendManager
from .group_router import GroupRouter
from .message_router import MessageRouter
from .typing_router import TypingRouter
from .file_transfer import FileTransferManager
from .ipc import IPCServer
from .protocol import Packet, PacketType, capability_for_packet
from .rendezvous import RendezvousService
from .settings import Settings

logger = logging.getLogger("meshtalk")

def _get_data_dir() -> Path:
    import os
    env = os.environ.get("MESHTALK_DATA_DIR")
    if env and env.strip():
        return Path(env.strip()).expanduser()
    return Path.home() / ".meshtalk"

DATA_DIR = _get_data_dir()


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
    friend_manager = FriendManager(identity, peer_manager, db)
    group_router = GroupRouter(identity, peer_manager, db, settings)
    router = MessageRouter(
        identity, peer_manager, db, friend_manager=friend_manager, group_router=group_router
    )
    typing_router = TypingRouter(identity, peer_manager, db, settings, friend_manager)
    file_manager = FileTransferManager(identity, peer_manager, db, DATA_DIR, settings=settings)
    tui_clients: set[str] = set()
    typing_clients: dict[tuple[str, str], set[str]] = {}

    async def _combined_packet_handler(peer: PeerConnection, packet: Packet) -> None:
        # File transfers take precedence; they handle their own packet types
        if await file_manager.handle_packet(peer, packet):
            return
        if await typing_router.handle_packet(peer, packet):
            return
        await router.handle_packet(peer, packet)

    peer_manager.on_packet = _combined_packet_handler

    async def flush_outgoing(peer_id: str) -> None:
        peer = peer_manager.get_connected_peer(peer_id)
        if peer is None:
            return
        try:
            await file_manager.resume_for_peer(peer_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to resume inbound files for %s: %s", peer_id, exc)
        # First flush queued file transfers via file manager (re-reads file)
        try:
            flushed_files = await file_manager.flush_for_peer(peer_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to flush queued files for %s: %s", peer_id, exc)
            flushed_files = 0
        items = await db.get_pending_outgoing(peer_id)
        if not items:
            if flushed_files:
                logger.info("Flushed %d queued file transfer(s) to %s", flushed_files, peer_id)
            return
        for item in items:
            packet_type = PacketType(item["packet_type"])
            required = capability_for_packet(packet_type)
            if required is not None and not peer.supports(required):
                if item["message_id"] and item.get("group_id"):
                    await db.set_group_delivery(item["message_id"], peer_id, "unavailable")
                elif item["message_id"]:
                    await db.mark_message_failed(item["message_id"])
                    await ipc.broadcast_event({"event": "message_failed", "message_id": item["message_id"]})
                await db.remove_from_outqueue(item["id"])
                continue
            # File transfers are flushed by file_manager to avoid sending their
            # offer and chunks twice through the generic outbound queue.
            if item["packet_type"] in (PacketType.FILE_OFFER.value, PacketType.FILE_CHUNK.value, PacketType.FILE_ACK.value):
                continue
            if not await group_router.can_flush(peer, item):
                if item["message_id"] and item.get("group_id"):
                    await db.set_group_delivery(item["message_id"], peer_id, "unavailable")
                await db.remove_from_outqueue(item["id"])
                continue
            try:
                packet = Packet(packet_type, item["encrypted_payload"])
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
        if peer is not None and peer.has_capability_gap:
            await ipc.broadcast_event({
                "event": "peer_capability_gap",
                "peer_id": peer_id,
                **peer.negotiated(),
            })
        if peer is not None:
            await group_router.peer_connected(peer_id)
            await flush_outgoing(peer_id)

    peer_manager.on_peer_changed = handle_peer_changed

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
        reply_to_message_id = req.get("reply_to_message_id")
        if reply_to_message_id is not None and (
            not isinstance(reply_to_message_id, str) or not reply_to_message_id or len(reply_to_message_id) > 128
        ):
            return {"error": "reply_to_message_id must be a non-empty string up to 128 characters"}
        msg_id, queued = await router.send_message(recipient, content.encode(), reply_to_message_id)
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
        if active_transport in ("remote_udp", "remote_derp") and not control_connected:
            warnings.append("rendezvous_out_of_sync")
        if getattr(connection, "has_capability_gap", False):
            warnings.append("limited")
        return warnings

    async def handle_peers(req: dict) -> dict:
        peers = await db.get_all_peers()
        unread_counts = await db.get_unread_counts(identity.peer_id)
        interaction_times = await db.get_peer_interaction_times(identity.peer_id)
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
                "last_interaction": interaction_times.get(peer["peer_id"], 0),
                "is_online": int((connection := peer_manager.get_connected_peer(peer["peer_id"])) is not None),
                "presence": "active" if connection and connection.tui_active else "away" if connection else "offline",
                "unread_count": unread_counts.get(peer["peer_id"], 0),
                "is_friend": peer["peer_id"] in friends,
                "is_blocked": peer["peer_id"] in blocked,
                "friend_request": friend_requests.get(peer["peer_id"]),
                "delivery_warnings": _peer_delivery_warnings(
                    connection,
                    peer["peer_id"] in friends,
                    (network_info := peer_manager.get_network_info(peer["peer_id"])).get("active_transport"),
                    rendezvous.connected,
                ),
                "capabilities": list(connection.capabilities) if connection else [],
                "remote_capabilities": list(connection.remote_capabilities or []) if connection else [],
                "peer_missing_capabilities": list(connection.peer_missing_capabilities) if connection else [],
                "local_missing_capabilities": list(connection.local_missing_capabilities) if connection else [],
                "capability_gap": connection.has_capability_gap if connection else False,
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
        if not active:
            await clear_client_typing(client_id)
        await update_tui_presence(client_id, active)
        return {"active": bool(tui_clients)}

    async def clear_client_typing(client_id: str) -> None:
        for (kind, conversation_id), clients in list(typing_clients.items()):
            if client_id not in clients:
                continue
            clients.discard(client_id)
            if clients:
                continue
            del typing_clients[(kind, conversation_id)]
            if kind == "peer":
                await typing_router.send_direct(conversation_id, False)
            else:
                await typing_router.send_group(conversation_id, False)

    async def handle_tui_disconnect(client_id: str) -> None:
        await clear_client_typing(client_id)
        await update_tui_presence(client_id, False)

    async def handle_typing(req: dict) -> dict:
        client_id = req.get("client_id")
        recipient_id = req.get("recipient_id")
        group_id = req.get("group_id")
        is_typing = req.get("is_typing")
        if not isinstance(client_id, str) or client_id not in tui_clients:
            return {"error": "active client_id required"}
        if not isinstance(is_typing, bool):
            return {"error": "is_typing must be boolean"}
        if (recipient_id is None) == (group_id is None):
            return {"error": "exactly one of recipient_id or group_id required"}
        if recipient_id is not None and (not isinstance(recipient_id, str) or not recipient_id):
            return {"error": "valid recipient_id required"}
        if group_id is not None and (not isinstance(group_id, str) or not group_id):
            return {"error": "valid group_id required"}
        kind, conversation_id = ("peer", recipient_id) if recipient_id is not None else ("group", group_id)
        key = (kind, conversation_id)
        clients = typing_clients.setdefault(key, set())
        if is_typing:
            clients.add(client_id)
            if kind == "peer":
                await typing_router.send_direct(conversation_id, True)
            else:
                await typing_router.send_group(conversation_id, True)
            return {"is_typing": True}
        clients.discard(client_id)
        if clients:
            return {"is_typing": True}
        typing_clients.pop(key, None)
        if kind == "peer":
            await typing_router.send_direct(conversation_id, False)
        else:
            await typing_router.send_group(conversation_id, False)
        return {"is_typing": False}

    async def handle_identity(req: dict) -> dict:
        return {
            "peer_id": identity.peer_id,
            "display_name": identity.display_name,
            "setup_dismissed": settings.identity_setup_dismissed or identity.display_name != "Anonymous",
            "flashing_enabled": settings.flashing_enabled,
        }

    async def handle_accessibility(req: dict) -> dict:
        flashing_enabled = req.get("flashing_enabled")
        if flashing_enabled is not None:
            if not isinstance(flashing_enabled, bool):
                return {"error": "flashing_enabled must be boolean"}
            settings.set_flashing_enabled(flashing_enabled)
        return {"flashing_enabled": settings.flashing_enabled}

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
                    "delivery_warnings": _peer_delivery_warnings(
                        peer,
                        peer.peer_id in friends,
                        (network_info := peer_manager.get_network_info(peer.peer_id)).get("active_transport"),
                        rendezvous.connected,
                    ),
                    "capabilities": list(peer.capabilities),
                    "remote_capabilities": list(peer.remote_capabilities or []),
                    "peer_missing_capabilities": list(peer.peer_missing_capabilities),
                    "local_missing_capabilities": list(peer.local_missing_capabilities),
                    "capability_gap": peer.has_capability_gap,
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

    async def handle_advanced_config(req: dict) -> dict:
        changed = False
        if "image_protocol" in req:
            image_protocol = req["image_protocol"]
            if not isinstance(image_protocol, str):
                return {"error": "image_protocol must be a string"}
            try:
                settings.set_image_protocol(image_protocol)
            except ValueError as exc:
                return {"error": str(exc)}
        if "splash_style" in req:
            splash_style = req["splash_style"]
            if not isinstance(splash_style, str):
                return {"error": "splash_style must be a string"}
            try:
                settings.set_splash_style(splash_style)
            except ValueError as exc:
                return {"error": str(exc)}
        if req.get("clear_control_pinned_ip") is True:
            settings.clear_control_pinned_ips()
            changed = True
        elif "control_pinned_ip" in req:
            control_pinned_ip = req["control_pinned_ip"]
            if not isinstance(control_pinned_ip, str):
                return {"error": "control_pinned_ip must be a string"}
            settings.set_control_pinned_ips(control_pinned_ip)
            changed = True
        elif req.get("auto_control_pinned_ip") is True:
            control_url = settings.control_url
            if not control_url:
                return {"error": "Configure a control server before auto-pinning it"}
            parsed = urlparse(control_url)
            addresses = await asyncio.get_running_loop().getaddrinfo(
                parsed.hostname, parsed.port or (443 if parsed.scheme == "wss" else 80),
                family=socket.AF_UNSPEC, type=socket.SOCK_STREAM,
            )
            values = list(dict.fromkeys(item[4][0] for item in addresses))
            if not values:
                return {"error": "Control server did not resolve to an IP address"}
            settings.set_control_pinned_ips(",".join(values))
            changed = True
        if req.get("clear_stun_pinned_ip") is True:
            settings.clear_stun_pinned_ips()
            changed = True
        elif "stun_pinned_ip" in req:
            stun_pinned_ip = req["stun_pinned_ip"]
            if not isinstance(stun_pinned_ip, str):
                return {"error": "stun_pinned_ip must be a string"}
            settings.set_stun_pinned_ips(stun_pinned_ip)
            changed = True
        elif req.get("auto_stun_pinned_ip") is True:
            stun_host, stun_port = settings.stun_server
            addresses = await asyncio.get_running_loop().getaddrinfo(
                stun_host, stun_port, family=socket.AF_INET, type=socket.SOCK_DGRAM,
            )
            values = list(dict.fromkeys(item[4][0] for item in addresses))
            if not values:
                return {"error": "STUN server did not resolve to an IPv4 address"}
            settings.set_stun_pinned_ips(",".join(values))
            changed = True
        if changed:
            rendezvous.configuration_changed()
        stun_host, stun_port = settings.stun_server
        return {
            "control_pinned_ips": list(settings.control_pinned_ips),
            "stun_pinned_ips": list(settings.stun_pinned_ips),
            "control_url": settings.control_url or None,
            "stun_server": f"{stun_host}:{stun_port}",
            "image_protocol": settings.image_protocol,
            "splash_style": settings.splash_style,
            "splash_duration_ms": settings.splash_duration_ms,
            "splash_phase_ms": settings.splash_phase_ms,
            "splash_welcome_ms": settings.splash_welcome_ms,
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
            member["is_limited"] = bool(connection and connection.has_capability_gap)
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
        reply_to_message_id = req.get("reply_to_message_id")
        if reply_to_message_id is not None and (
            not isinstance(reply_to_message_id, str) or not reply_to_message_id or len(reply_to_message_id) > 128
        ):
            return {"error": "reply_to_message_id must be a non-empty string up to 128 characters"}
        message_id, deliveries = await group_router.send_message(group_id, content.encode(), reply_to_message_id)
        return {"message_id": message_id, "deliveries": deliveries}

    async def handle_delete_message(req: dict) -> dict:
        message_id = req.get("message_id")
        group_id = req.get("group_id")
        if not isinstance(message_id, str) or not message_id:
            return {"error": "message_id required"}
        if group_id is not None and not isinstance(group_id, str):
            return {"error": "group_id must be a string"}
        is_file = req.get("file") is True
        transfer = await db.delete_file_transfer_locally(message_id) if is_file else None
        if is_file:
            if transfer is None:
                return {"error": "attachment not found"}
            if transfer["direction"] == "inbound" and transfer.get("file_path"):
                try:
                    Path(transfer["file_path"]).unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove local attachment file %s", transfer["file_path"])
        else:
            deleted = await db.delete_message_locally(message_id, group_id)
            if not deleted:
                return {"error": "message not found"}
        return {"message_id": message_id, "deleted": True}

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

    async def handle_notifications(req: dict) -> dict:
        setup_dismissed = req.get("setup_dismissed")
        delivery = req.get("delivery")
        events = req.get("events")
        if setup_dismissed is not None and not isinstance(setup_dismissed, bool):
            return {"error": "setup_dismissed must be a boolean"}
        if delivery is not None and not isinstance(delivery, str):
            return {"error": "delivery must be a string"}
        if events is not None and not isinstance(events, dict):
            return {"error": "events must be an object"}
        try:
            settings.set_notification_preferences(
                setup_dismissed=setup_dismissed,
                delivery=delivery,
                events=events,
            )
        except ValueError as exc:
            return {"error": str(exc)}
        return settings.notification_preferences

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
                "capabilities": list(connection.capabilities) if connection else [],
                "remote_capabilities": list(connection.remote_capabilities or []) if connection else [],
                "peer_missing_capabilities": list(connection.peer_missing_capabilities) if connection else [],
                "local_missing_capabilities": list(connection.local_missing_capabilities) if connection else [],
                **info,
            })
        return {
            "public_endpoint": list(rendezvous.public_endpoint) if rendezvous.public_endpoint else None,
            "stun_server": f"{stun_host}:{stun_port}",
            "local_tcp_port": peer_manager.tcp_port,
            "rooms": rendezvous.room_status(),
            "peers": peers_info,
        }

    async def handle_file_send(req: dict) -> dict:
        recipient_id = req.get("recipient_id")
        file_path = req.get("file_path")
        if not isinstance(recipient_id, str) or not recipient_id:
            return {"error": "recipient_id required"}
        if not isinstance(file_path, str) or not file_path:
            return {"error": "file_path required"}
        try:
            file_id = await file_manager.send_file(recipient_id, file_path)
        except ValueError as exc:
            return {"error": str(exc)}
        except Exception as exc:
            logger.exception("file_send failed")
            return {"error": str(exc)}
        return {"file_id": file_id}

    async def handle_group_file_send(req: dict) -> dict:
        group_id = req.get("group_id")
        file_path = req.get("file_path")
        if not isinstance(group_id, str) or not group_id:
            return {"error": "group_id required"}
        if not isinstance(file_path, str) or not file_path:
            return {"error": "file_path required"}
        if group_id not in settings.rooms or settings.rooms[group_id].group_name is None:
            return {"error": "Unknown group"}
        members = await db.get_group_members(group_id)
        results = []
        errors = []
        for member in members:
            recipient_id = member["peer_id"]
            if recipient_id == identity.peer_id:
                continue
            if await db.is_peer_blocked(recipient_id):
                continue
            try:
                fid = await file_manager.send_file(recipient_id, file_path, group_id=group_id)
                results.append({"recipient_id": recipient_id, "file_id": fid})
            except Exception as exc:
                errors.append(f"{recipient_id[:8]}: {exc}")
        if not results and errors:
            return {"error": "; ".join(errors)}
        return {"results": results, "errors": errors}

    async def handle_files(req: dict) -> dict:
        transfers = await file_manager.list_transfers()
        # Normalize file_path for display: convert to string if Path
        for t in transfers:
            if t.get("file_path"):
                # Make path cross-platform display; use as-is
                t["file_path"] = str(t["file_path"])
        return {"files": transfers}

    async def handle_file_info(req: dict) -> dict:
        file_id = req.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            return {"error": "file_id required"}
        transfer = await file_manager.get_transfer(file_id)
        if not transfer:
            return {"error": "Unknown file_id"}
        return {"file": transfer}

    async def handle_file_download(req: dict) -> dict:
        file_id = req.get("file_id")
        dest_path = req.get("dest_path") or req.get("file_path") or req.get("dest")
        if not isinstance(file_id, str) or not file_id:
            return {"error": "file_id required"}
        if not isinstance(dest_path, str) or not dest_path:
            return {"error": "dest_path required"}
        try:
            final = await file_manager.download_file(file_id, dest_path)
        except ValueError as exc:
            return {"error": str(exc)}
        except Exception as exc:
            logger.exception("file_download failed")
            return {"error": str(exc)}
        return {"file_id": file_id, "dest_path": final}

    async def handle_files_dir(req: dict) -> dict:
        # Get or set files storage directory (cross-platform: supports E:\, /mnt/e, etc.)
        new_path = req.get("path") or req.get("files_dir") or req.get("dir")
        if new_path is not None:
            if not isinstance(new_path, str) or not new_path.strip():
                return {"error": "path must be a non-empty string"}
            # Allow clearing to default via empty or "default"
            if new_path.strip().lower() in ("default", "clear", "reset"):
                settings.clear_files_dir()
                return {"files_dir": str(settings.files_dir), "configured": None, "env": os.environ.get("MESHTALK_FILES_DIR")}
            try:
                final = settings.set_files_dir(new_path)
            except ValueError as exc:
                return {"error": str(exc)}
            return {"files_dir": str(final), "configured": settings._files_dir, "env": os.environ.get("MESHTALK_FILES_DIR")}
        return {"files_dir": str(settings.files_dir), "configured": settings._files_dir, "env": os.environ.get("MESHTALK_FILES_DIR"), "data_dir": str(DATA_DIR)}

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
        "typing": handle_typing,
        "identity": handle_identity,
        "accessibility": handle_accessibility,
        "status": handle_status,
        "messages": handle_messages,
        "set_display_name": handle_set_display_name,
        "control": handle_control,
        "advanced_config": handle_advanced_config,
        "room_create": handle_room_create,
        "room_join": handle_room_join,
        "room_leave": handle_room_leave,
        "room_invite": handle_room_invite,
        "rooms": handle_rooms,
        "groups": handle_groups,
        "group_members": handle_group_members,
        "group_messages": handle_group_messages,
        "group_send": handle_group_send,
        "delete_message": handle_delete_message,
        "group_leave": handle_group_leave,
        "mute": handle_mute,
        "unmute": handle_unmute,
        "muted_peers": handle_muted_peers,
        "notifications": handle_notifications,
        "debug_re_stun": handle_debug_re_stun,
        "debug_info": handle_debug_info,
        "file_send": handle_file_send,
        "group_file_send": handle_group_file_send,
        "files": handle_files,
        "file_info": handle_file_info,
        "file_download": handle_file_download,
        "files_dir": handle_files_dir,
        "set_files_dir": handle_files_dir,
        "shutdown": handle_shutdown,
    }
    ipc = IPCServer(
        ipc_handlers,
        on_tui_disconnect=handle_tui_disconnect,
    )
    router.on_received = lambda message: ipc.broadcast_event({"event": "message", **message})
    router.on_delivered = lambda message_id: ipc.broadcast_event({"event": "delivered", "message_id": message_id})
    group_router.on_event = ipc.broadcast_event
    typing_router.on_event = ipc.broadcast_event
    friend_manager.on_friend_request = lambda event: ipc.broadcast_event({"event": "friend_request", **event})
    friend_manager.on_friend_response = lambda event: ipc.broadcast_event({"event": "friend_response", **event})
    friend_manager.on_friend_cancelled = lambda event: ipc.broadcast_event({"event": "friend_cancelled", **event})
    friend_manager.on_message_blocked = lambda event: ipc.broadcast_event({"event": "message_blocked", **event})
    file_manager.on_event = ipc.broadcast_event

    # Start IPC first so the TUI/CLI can connect quickly even if network
    # discovery or rendezvous is slow on Windows. This avoids the splash
    # screen hanging at "Connecting to backend" for 60s before timing out.
    await ipc.start()
    await peer_manager.start()
    await peer_manager.load_endpoints()
    await group_router.sync_groups()
    await discovery.start()
    await rendezvous.start()

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

    try:
        await stop_event.wait()
    finally:
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
