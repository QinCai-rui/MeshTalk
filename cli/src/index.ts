import { IPCClient, type IPCResponse } from "../../common/ipc-client";
import { basename } from "path";

const PROGRAM = basename(process.env.MESHTALK_PROGRAM ?? process.argv[1] ?? process.argv[0]);
const USAGE = `Usage: ${PROGRAM} <command> [args]

Commands:
  identity [display-name]     Show or change this peer's display name
  status                      Show control and peer connection status
  peers                       List peers, transports, and endpoints
  messages <peer-id>          Show conversation history
  send <peer-id> <message>    Send an encrypted direct message
  watch                       Print incoming messages until interrupted
  control [set-url <url>]      Show or configure the control service
  room create                 Create a private multi-peer room
  room join <invite>          Join a private room
  room leave <room-id>        Leave a room
  rooms                       List joined rooms
  friends                     List your friends
  friend-requests             List pending friend requests
  friend send <peer-id> [note]  Send a friend request
  friend accept <request-id>     Accept a friend request
  friend decline <request-id>    Decline a friend request
  friend remove <peer-id>        Remove a friend
  blocked                     List peers whose friend requests are ignored
  block <peer-id>             Ignore friend requests from a peer
  unblock <peer-id>           Allow friend requests from a peer again
`;

function hasError(response: IPCResponse): boolean {
  if (response.error) {
    console.error(`Error: ${response.error}`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function transportName(value: unknown): string {
  if (value === "lan_tcp") return "LAN TCP";
  if (value === "remote_udp") return "Remote UDP";
  return "not connected";
}

function friendLabel(peer: Record<string, unknown>): string {
  const status = peer.friend_request;
  if (peer.is_friend) return " friend";
  if (status === "incoming") return " request-pending (respond with `friend accept`)";
  if (status === "outgoing") return " request-sent";
  if (status === "both") return " request-pending";
  return "";
}

function printPeer(peer: Record<string, unknown>): void {
  const endpoint = peer.active_endpoint ? ` via ${transportName(peer.active_transport)} ${peer.active_endpoint}` : "";
  console.log(`${peer.display_name} (${String(peer.peer_id).slice(0, 12)}) ${peer.is_online ? "online" : "offline"}${friendLabel(peer)}${endpoint}`);
  for (const item of asRecords(peer.endpoints)) {
    if (!item.active) console.log(`  ${transportName(item.transport)} ${item.endpoint}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help") {
    console.log(USAGE);
    return;
  }

  const ipc = new IPCClient();
  try {
    await ipc.connect();
  } catch (error) {
    console.error(`Error: Cannot connect to MeshTalk backend. ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (command === "identity") {
      if (args.length) {
        const response = await ipc.send("set_display_name", { display_name: args.join(" ") });
        if (hasError(response)) return;
        console.log(`Display name updated: ${response.display_name}`);
        return;
      }
      const response = await ipc.send("identity");
      if (hasError(response)) return;
      console.log(`Peer ID: ${response.peer_id}`);
      console.log(`Display name: ${response.display_name}`);
      return;
    }

    if (command === "status") {
      const response = await ipc.send("status");
      if (hasError(response)) return;
      console.log(`Peer ID: ${response.peer_id}`);
      console.log(`Connected peers: ${response.connected_peers}`);
      console.log(`Control: ${response.control_connected ? "connected" : "disconnected"}${response.control_url ? ` (${response.control_url})` : " (not configured)"}`);
      if (response.public_endpoint) console.log(`Public UDP endpoint: ${response.public_endpoint}`);
      for (const peer of asRecords(response.peers)) {
        printPeer(peer);
      }
      return;
    }

    if (command === "peers") {
      const response = await ipc.send("peers");
      if (hasError(response)) return;
      const peers = asRecords(response.peers);
      if (!peers.length) console.log("No peers discovered.");
      for (const peer of peers) printPeer(peer);
      return;
    }

    if (command === "messages") {
      if (!args[0]) throw new Error(`Usage: ${PROGRAM} messages <peer-id>`);
      const response = await ipc.send("messages", { peer_id: args[0] });
      if (hasError(response)) return;
      for (const message of asRecords(response.messages)) {
        const time = new Date(Number(message.created_at) * 1000).toLocaleString();
        console.log(`[${time}] ${String(message.sender_id).slice(0, 12)}: ${message.content ?? ""}`);
      }
      return;
    }

    if (command === "send") {
      const [peerId, ...words] = args;
      const content = words.join(" ");
      if (!peerId || !content) throw new Error(`Usage: ${PROGRAM} send <peer-id> <message>`);
      const response = await ipc.send("send", { recipient_id: peerId, content });
      if (hasError(response)) return;
      console.log(`Sent ${response.message_id}`);
      return;
    }

    if (command === "watch") {
      console.log("Watching for incoming messages. Press Ctrl+C to stop.");
      ipc.onEvent((event) => {
        if (event.event === "message") {
          console.log(`${String(event.sender_id).slice(0, 12)}: ${event.content ?? ""}`);
        }
      });
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      return;
    }

    if (command === "control") {
      let response: IPCResponse;
      if (!args.length) {
        response = await ipc.send("control");
      } else if (args[0] === "set-url" && args[1] && args.length === 2) {
        response = await ipc.send("control", { url: args[1] });
      } else {
        throw new Error(`Usage: ${PROGRAM} control [set-url <url>]`);
      }
      if (hasError(response)) return;
      console.log(`Control URL: ${response.url ?? "not configured"}`);
      console.log(`Connection: ${response.connected ? "connected" : "disconnected"}`);
      console.log(`STUN server: ${response.stun_server}`);
      if (response.public_endpoint) console.log(`Public UDP endpoint: ${(response.public_endpoint as unknown[]).join(":")}`);
      return;
    }

    if (command === "room") {
      let response: IPCResponse;
      if (args[0] === "create" && args.length === 1) {
        response = await ipc.send("room_create");
        if (hasError(response)) return;
        console.log(`Room ID: ${response.room_id}`);
        console.log(`Invite: ${response.invite}`);
        console.log("Treat this invite as a secret. Anyone holding it can join the room.");
        return;
      }
      if (args[0] === "join" && args[1] && args.length === 2) {
        response = await ipc.send("room_join", { invite: args[1] });
      } else if (args[0] === "leave" && args[1] && args.length === 2) {
        response = await ipc.send("room_leave", { room_id: args[1] });
      } else {
        throw new Error(`Usage: ${PROGRAM} room <create|join|leave> [value]`);
      }
      if (hasError(response)) return;
      console.log(`${args[0] === "join" ? "Joined" : "Left"} room ${response.room_id}`);
      return;
    }

    if (command === "rooms") {
      const response = await ipc.send("rooms");
      if (hasError(response)) return;
      const rooms = asRecords(response.rooms);
      if (!rooms.length) console.log("No joined rooms.");
      for (const room of rooms) console.log(`${room.room_id} (${room.members} control connections)`);
      return;
    }

    if (command === "friends") {
      const response = await ipc.send("friends");
      if (hasError(response)) return;
      const friends = asRecords(response.friends);
      if (!friends.length) console.log("No friends yet. Send a friend request to chat.");
      for (const friend of friends) console.log(`${friend.display_name} (${String(friend.peer_id).slice(0, 12)})`);
      return;
    }

    if (command === "friend-requests") {
      const response = await ipc.send("friend_requests");
      if (hasError(response)) return;
      const requests = asRecords(response.requests);
      if (!requests.length) console.log("No pending friend requests.");
      for (const request of requests) {
        if (request.direction === "incoming") {
          console.log(`Incoming: ${request.sender_name} (${request.request_id})${request.note ? ` - ${request.note}` : ""}`);
          console.log(`  Respond with: friend accept ${request.request_id} | friend decline ${request.request_id}`);
        } else {
          console.log(`Pending to: ${request.recipient_name ?? request.sender_name} (${request.request_id})`);
        }
      }
      return;
    }

    if (command === "friend") {
      const [subcommand, ...rest] = args;
      let response: IPCResponse;
      if (subcommand === "send" && rest[0]) {
        const [peerId, ...words] = rest;
        const note = words.join(" ");
        response = await ipc.send("friend_send", { peer_id: peerId, note });
        if (hasError(response)) return;
        console.log(`Friend request sent to ${peerId}: ${response.request_id}`);
      } else if (subcommand === "accept" && rest[0]) {
        response = await ipc.send("friend_respond", { request_id: rest[0], accept: true });
        if (hasError(response)) return;
        console.log(`Friend request ${rest[0]} accepted. You can now chat.`);
      } else if (subcommand === "decline" && rest[0]) {
        response = await ipc.send("friend_respond", { request_id: rest[0], accept: false });
        if (hasError(response)) return;
        console.log(`Friend request ${rest[0]} declined.`);
      } else if (subcommand === "remove" && rest[0]) {
        response = await ipc.send("unfriend", { peer_id: rest[0] });
        if (hasError(response)) return;
        console.log(`Removed ${rest[0]} as a friend.`);
      } else {
        throw new Error(`Usage: ${PROGRAM} friend <send <peer-id> [note]|accept <request-id>|decline <request-id>|remove <peer-id>>`);
      }
      return;
    }

    if (command === "blocked") {
      const response = await ipc.send("blocked_peers");
      if (hasError(response)) return;
      const blocked = asRecords(response.blocked);
      if (!blocked.length) console.log("No blocked peers. Blocked peers cannot send you friend requests.");
      for (const peer of blocked) console.log(`${peer.display_name} (${String(peer.peer_id).slice(0, 12)})`);
      return;
    }

    if (command === "block" && args[0]) {
      const response = await ipc.send("block_peer", { peer_id: args[0] });
      if (hasError(response)) return;
      console.log(`Blocked ${args[0]}. Their friend requests are now ignored.`);
      return;
    }

    if (command === "unblock" && args[0]) {
      const response = await ipc.send("unblock_peer", { peer_id: args[0] });
      if (hasError(response)) return;
      console.log(`Unblocked ${args[0]}. They can send friend requests again.`);
      return;
    }

    throw new Error(`Unknown command: ${command}\n${USAGE}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    ipc.close();
  }
}

void main();
