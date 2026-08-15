/**
 * IPC client for communicating with the MeshTalk backend.
 * Connects via Unix domain socket at ~/.meshtalk/meshtalk.sock
 */

import { createConnection, type Socket } from "net";

const SOCKET_PATH = `${process.env.HOME}/.meshtalk/meshtalk.sock`;

export interface IPCResponse {
  error?: string;
  [key: string]: unknown;
}

export type IPCEvent = { event: string; [key: string]: unknown };

export class IPCClient {
  private socket: Socket | null = null;
  private buffer = "";
  private pending: Map<number, { resolve: (v: IPCResponse) => void; reject: (e: Error) => void }> = new Map();
  private id = 0;
  private eventHandlers = new Set<(event: IPCEvent) => void>();
  private disconnectHandlers = new Set<() => void>();
  private intentionallyClosed = false;
  private closed = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionallyClosed = false;
      this.closed = false;
      this.socket = createConnection(SOCKET_PATH);
      this.socket.on("connect", () => resolve());
      this.socket.on("error", (err) => reject(err));
      this.socket.on("data", (data: string | Buffer) => this.onData(data.toString()));
      this.socket.on("close", () => this.onClose());
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.socket?.destroy();
  }

  onEvent(handler: (event: IPCEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  async send(action: string, params: Record<string, unknown> = {}): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error("Not connected"));
      }
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      const request = JSON.stringify({ id, action, ...params }) + "\n";
      this.socket.write(request);
    });
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response: IPCResponse = JSON.parse(line);
        if (typeof response.event === "string") {
          for (const handler of this.eventHandlers) handler(response as IPCEvent);
          continue;
        }
        const id = response.id as number | undefined;
        const entry = id === undefined ? undefined : this.pending.get(id);
        if (entry) {
          this.pending.delete(id!);
          entry.resolve(response);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new Error("Connection closed"));
    }
    this.pending.clear();
    if (!this.intentionallyClosed) {
      for (const handler of this.disconnectHandlers) handler();
    }
  }
}
