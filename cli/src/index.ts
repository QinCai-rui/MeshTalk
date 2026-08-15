import { IPCClient, type IPCResponse } from "../../common/ipc-client";

const USAGE = `Usage: lanchat-cli <command> [args]

Commands:
  identity [display-name]     Show or change this peer's display name
  status                      Show connected peers
  peers                       List discovered peers
  messages <peer-id>          Show conversation history
  send <peer-id> <message>    Send an encrypted direct message
  watch                       Print incoming messages until interrupted
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
    console.error(`Error: Cannot connect to LanChat backend. ${error instanceof Error ? error.message : String(error)}`);
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
      for (const peer of asRecords(response.peers)) {
        console.log(`  ${peer.display_name} (${String(peer.peer_id).slice(0, 12)})`);
      }
      return;
    }

    if (command === "peers") {
      const response = await ipc.send("peers");
      if (hasError(response)) return;
      const peers = asRecords(response.peers);
      if (!peers.length) console.log("No peers discovered.");
      for (const peer of peers) {
        console.log(`${peer.display_name} (${String(peer.peer_id).slice(0, 12)}) ${peer.is_online ? "online" : "offline"}`);
      }
      return;
    }

    if (command === "messages") {
      if (!args[0]) throw new Error("Usage: lanchat-cli messages <peer-id>");
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
      if (!peerId || !content) throw new Error("Usage: lanchat-cli send <peer-id> <message>");
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

    throw new Error(`Unknown command: ${command}\n${USAGE}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    ipc.close();
  }
}

void main();
