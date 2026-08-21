/**
 * IPC client for communicating with the MeshTalk backend.
 * Connects via Unix domain socket (Linux/macOS) or TCP (Windows).
 */

import { createConnection, type Socket } from "net";
import { readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DATA_DIR = process.env.MESHTALK_DATA_DIR || `${HOME}/.meshtalk`;
const SOCKET_PATH = process.env.MESHTALK_IPC_SOCKET || `${DATA_DIR}/meshtalk.sock`;
const PORT_PATH = `${DATA_DIR}/meshtalk.port`;
const TOKEN_PATH = process.env.MESHTALK_IPC_TOKEN || `${DATA_DIR}/meshtalk.token`;

function getIpcPort(): number | null {
  const envPort = process.env.MESHTALK_IPC_PORT;
  if (envPort) {
    const p = Number(envPort);
    if (Number.isInteger(p) && p > 0) return p;
  }
  return null;
}

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
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionallyClosed = false;
      this.closed = false;
      this.connectResolve = resolve;
      this.connectReject = reject;

      const authenticate = () => {
        try {
          const token = readFileSync(TOKEN_PATH, "utf-8").trim();
          this.socket?.write(JSON.stringify({ action: "authenticate", token }) + "\n");
        } catch {
          reject(new Error("Cannot authenticate with MeshTalk backend"));
        }
      };

      const connectTcp = () => {
        try {
          const port = Number(readFileSync(PORT_PATH, "utf-8").trim());
          this.socket = createConnection(port, "127.0.0.1");
          this.socket.on("connect", authenticate);
          this.socket.on("error", (err) => reject(err));
          this.socket.on("data", (data: string | Buffer) => this.onData(data.toString()));
          this.socket.on("close", () => this.onClose());
        } catch {
          reject(new Error("Cannot connect to MeshTalk backend"));
        }
      };

      const connectUnix = () => {
        this.socket = createConnection(SOCKET_PATH);
        this.socket.on("connect", authenticate);
        this.socket.on("error", () => { try { this.socket?.destroy(); } catch {} connectTcp(); });
        this.socket.on("data", (data: string | Buffer) => this.onData(data.toString()));
        this.socket.on("close", () => this.onClose());
      };

      const forcedPort = getIpcPort();
      if (forcedPort !== null) {
        this.socket = createConnection(forcedPort, "127.0.0.1");
        this.socket.on("connect", authenticate);
        this.socket.on("error", (err) => reject(err));
        this.socket.on("data", (data: string | Buffer) => this.onData(data.toString()));
        this.socket.on("close", () => this.onClose());
      } else if (process.platform === "win32") {
        connectTcp();
      } else {
        connectUnix();
      }
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
        if (response.authenticated === true && this.connectResolve) {
          this.connectResolve();
          this.connectResolve = null;
          this.connectReject = null;
          continue;
        }
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
    if (this.connectReject) {
      if (this.intentionallyClosed) {
        this.connectResolve?.();
      } else {
        this.connectReject(new Error("Connection closed during authentication"));
      }
      this.connectResolve = null;
      this.connectReject = null;
    }
    for (const entry of this.pending.values()) {
      if (this.intentionallyClosed) {
        entry.resolve({ error: "Connection closed" });
      } else {
        entry.reject(new Error("Connection closed"));
      }
    }
    this.pending.clear();
    if (!this.intentionallyClosed) {
      for (const handler of this.disconnectHandlers) handler();
    }
  }
}
