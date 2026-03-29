import { WebSocketServer, WebSocket } from 'ws';
import type { Operation, SyncMessage, Doc } from '@local-first/store';
import { applyOperation, serializeHLC, deserializeHLC, compareHLC } from '@local-first/store';

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  lastSyncHLC?: string;
}

export interface SyncServerConfig {
  port?: number;
  host?: string;
  /** Optional auth token — clients must pass ?token=<value> to connect */
  token?: string;
  /** Max messages per second per client (default 100) */
  maxMessagesPerSecond?: number;
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class SyncServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ConnectedClient>();
  private oplog: Operation[] = [];
  private opIds = new Set<string>();
  private docs = new Map<string, Map<string, Doc>>();
  private messageCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(private config: SyncServerConfig = {}) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.config.port ?? 3000;
      const host = this.config.host ?? '0.0.0.0';

      const verifyClient = this.config.token
        ? (info: { req: import('http').IncomingMessage }) => {
            const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`);
            return url.searchParams.get('token') === this.config.token;
          }
        : undefined;

      this.wss = new WebSocketServer({ port, host, verifyClient }, () => {
        resolve();
      });

      this.wss.on('error', (err) => {
        reject(err);
      });

      this.wss.on('connection', (ws: WebSocket) => {
        this.handleConnection(ws);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.wss) {
        resolve();
        return;
      }

      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.terminate();
      }
      this.clients.clear();

      this.wss.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.wss = null;
          resolve();
        }
      });
    });
  }

  private handleConnection(ws: WebSocket): void {
    // clientId will be set on first message
    const tempId = `pending-${Date.now()}-${Math.random()}`;
    const client: ConnectedClient = { ws, clientId: tempId };

    ws.on('message', (data: Buffer | string) => {
      try {
        this.handleMessage(client, data.toString());
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.clients.delete(client.clientId);
      this.messageCounts.delete(client.clientId);
    });

    ws.on('error', () => {
      this.clients.delete(client.clientId);
      this.messageCounts.delete(client.clientId);
      ws.terminate();
    });
  }

  private checkRateLimit(clientId: string): boolean {
    const maxPerSec = this.config.maxMessagesPerSecond ?? 100;
    const now = Date.now();
    const entry = this.messageCounts.get(clientId);
    if (!entry || now >= entry.resetAt) {
      this.messageCounts.set(clientId, { count: 1, resetAt: now + 1000 });
      return true;
    }
    entry.count++;
    return entry.count <= maxPerSec;
  }

  private handleMessage(client: ConnectedClient, data: string): void {
    let msg: SyncMessage;
    try {
      msg = JSON.parse(data) as SyncMessage;
    } catch {
      return;
    }

    if (typeof msg.clientId === 'string' && client.clientId.startsWith('pending-')) {
      // Register client on first real message
      this.clients.delete(client.clientId);
      client.clientId = msg.clientId;
      this.clients.set(client.clientId, client);
    }

    if (!this.checkRateLimit(client.clientId)) {
      const errorMsg: SyncMessage = {
        type: 'ack',
        clientId: 'server',
        error: 'rate limit exceeded',
      };
      client.ws.send(JSON.stringify(errorMsg));
      return;
    }

    if (msg.type === 'pull') {
      this.handlePull(client, msg);
    } else if (msg.type === 'push') {
      this.handlePush(client, msg);
    }
  }

  private handlePull(client: ConnectedClient, msg: SyncMessage): void {
    const ops = this.getOpsSince(msg.since);
    const response: SyncMessage = {
      type: 'ops',
      clientId: 'server',
      ops,
    };
    client.ws.send(JSON.stringify(response));
  }

  private validateOp(op: unknown): op is Operation {
    if (typeof op !== 'object' || op === null) return false;
    const o = op as Record<string, unknown>;
    return (
      typeof o.id === 'string' &&
      typeof o.type === 'string' &&
      ['put', 'update', 'delete'].includes(o.type as string) &&
      typeof o.collection === 'string' &&
      typeof o.docId === 'string' &&
      typeof o.clientId === 'string' &&
      typeof o.hlc === 'object' && o.hlc !== null
    );
  }

  private handlePush(client: ConnectedClient, msg: SyncMessage): void {
    const ops = msg.ops ?? [];
    if (ops.length === 0) return;

    const validOps = ops.filter(op => this.validateOp(op));
    if (validOps.length === 0) return;

    this.mergeOps(validOps);

    // Update client's last known HLC
    const lastOp = validOps[validOps.length - 1];
    if (lastOp) {
      client.lastSyncHLC = serializeHLC(lastOp.hlc);
    }

    // Acknowledge
    const ack: SyncMessage = {
      type: 'ack',
      clientId: 'server',
      ackId: validOps[validOps.length - 1]?.id,
    };
    client.ws.send(JSON.stringify(ack));

    // Broadcast to other clients
    this.broadcast(validOps, client.clientId);
  }

  private broadcast(ops: Operation[], excludeClientId: string): void {
    const msg: SyncMessage = {
      type: 'ops',
      clientId: 'server',
      ops,
    };
    const encoded = JSON.stringify(msg);

    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(encoded);
      }
    }
  }

  private mergeOps(ops: Operation[]): void {
    for (const op of ops) {
      // Prototype pollution protection
      if (BLOCKED_KEYS.has(op.collection) || BLOCKED_KEYS.has(op.docId)) continue;

      // Append to oplog (deduplicate by id — O(1) Set lookup)
      if (!this.opIds.has(op.id)) {
        this.opIds.add(op.id);
        this.oplog.push(op);
      }

      // Apply to in-memory doc state
      if (!this.docs.has(op.collection)) {
        this.docs.set(op.collection, new Map());
      }
      const collection = this.docs.get(op.collection)!;
      const existing = collection.get(op.docId) ?? null;
      const updated = applyOperation(existing, op);
      collection.set(op.docId, updated);
    }
  }

  private getOpsSince(since?: string): Operation[] {
    if (!since) return [...this.oplog];
    try {
      const sinceHlc = deserializeHLC(since);
      return this.oplog.filter((op) => compareHLC(op.hlc, sinceHlc) > 0);
    } catch {
      return [...this.oplog];
    }
  }
}
