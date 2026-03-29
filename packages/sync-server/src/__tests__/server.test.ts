import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { SyncServer } from '../server.js';
import type { SyncMessage, Operation } from '@local-first/store';

function randomPort(): number {
  return Math.floor(40000 + Math.random() * 10000);
}

function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: `op-${Math.random().toString(36).slice(2)}`,
    type: 'put',
    collection: 'items',
    docId: 'doc-1',
    fields: { name: 'test' },
    hlc: { ts: Date.now(), counter: 0, node: 'node-1' },
    clientId: 'client-1',
    ...overrides,
  };
}

function connectClient(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token ? `ws://localhost:${port}?token=${token}` : `ws://localhost:${port}`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<SyncMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as SyncMessage);
    });
  });
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Server start / stop
// ---------------------------------------------------------------------------
describe('SyncServer start and stop', () => {
  it('starts and resolves without error', async () => {
    const server = new SyncServer({ port: randomPort() });
    await expect(server.start()).resolves.toBeUndefined();
    await server.stop();
  });

  it('stop resolves without error after start', async () => {
    const server = new SyncServer({ port: randomPort() });
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stop resolves without error when never started', async () => {
    const server = new SyncServer({ port: randomPort() });
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client connect + pull
// ---------------------------------------------------------------------------
describe('Client pull', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('client can connect and send pull, receives ops response', async () => {
    const ws = await connectClient(port);

    const pullMsg: SyncMessage = { type: 'pull', clientId: 'client-A' };
    ws.send(JSON.stringify(pullMsg));

    const response = await waitForMessage(ws);
    expect(response.type).toBe('ops');
    expect(Array.isArray(response.ops)).toBe(true);

    await closeClient(ws);
  });

  it('pull response contains all ops when no since is provided', async () => {
    // Push an op from one client first
    const pusher = await connectClient(port);
    const op = makeOp({ clientId: 'pusher', id: 'op-seed' });
    const pushMsg: SyncMessage = { type: 'push', clientId: 'pusher', ops: [op] };
    pusher.send(JSON.stringify(pushMsg));
    // Wait for ack
    await waitForMessage(pusher);

    // Now pull from a different client
    const puller = await connectClient(port);
    const pullMsg: SyncMessage = { type: 'pull', clientId: 'puller' };
    puller.send(JSON.stringify(pullMsg));

    const response = await waitForMessage(puller);
    expect(response.type).toBe('ops');
    expect(response.ops!.some((o) => o.id === 'op-seed')).toBe(true);

    await closeClient(pusher);
    await closeClient(puller);
  });
});

// ---------------------------------------------------------------------------
// Client push + broadcast
// ---------------------------------------------------------------------------
describe('Client push and broadcast', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('push sends ack to the pushing client', async () => {
    const ws = await connectClient(port);
    const op = makeOp({ id: 'op-push-ack' });
    const pushMsg: SyncMessage = { type: 'push', clientId: 'client-A', ops: [op] };
    ws.send(JSON.stringify(pushMsg));

    const ack = await waitForMessage(ws);
    expect(ack.type).toBe('ack');
    expect(ack.ackId).toBe('op-push-ack');

    await closeClient(ws);
  });

  it('push broadcasts ops to other connected clients', async () => {
    const sender = await connectClient(port);
    const receiver = await connectClient(port);

    // Register receiver with a pull so the server knows its clientId
    const pullMsg: SyncMessage = { type: 'pull', clientId: 'receiver-client' };
    receiver.send(JSON.stringify(pullMsg));
    await waitForMessage(receiver); // consume ops response

    // Now sender pushes an op
    const op = makeOp({ id: 'op-broadcast', clientId: 'sender-client' });
    const pushMsg: SyncMessage = { type: 'push', clientId: 'sender-client', ops: [op] };
    sender.send(JSON.stringify(pushMsg));

    // Receiver should get the broadcast
    const broadcast = await waitForMessage(receiver);
    expect(broadcast.type).toBe('ops');
    expect(broadcast.ops!.some((o) => o.id === 'op-broadcast')).toBe(true);

    await closeClient(sender);
    await closeClient(receiver);
  });
});

// ---------------------------------------------------------------------------
// Op validation
// ---------------------------------------------------------------------------
describe('Op validation', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('invalid ops (missing required fields) are filtered — no ack sent', async () => {
    const ws = await connectClient(port);

    const badOp = { id: 'bad-op' }; // missing type, collection, docId, hlc, clientId
    const pushMsg = { type: 'push', clientId: 'client-A', ops: [badOp] };
    ws.send(JSON.stringify(pushMsg));

    // No ack should arrive because all ops were invalid (validOps.length === 0)
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 300));
    const result = await Promise.race([waitForMessage(ws), timeout]);
    expect(result).toBeNull();

    await closeClient(ws);
  });
});

// ---------------------------------------------------------------------------
// Prototype pollution guard
// ---------------------------------------------------------------------------
describe('Prototype pollution guard', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('ops with __proto__ as collection are skipped', async () => {
    const ws = await connectClient(port);

    // Build an otherwise-valid op but with __proto__ as collection
    const maliciousOp: Operation = {
      id: 'proto-op',
      type: 'put',
      collection: '__proto__',
      docId: 'doc-1',
      fields: { polluted: true },
      hlc: { ts: Date.now(), counter: 0, node: 'node-1' },
      clientId: 'client-A',
    };
    const pushMsg: SyncMessage = { type: 'push', clientId: 'client-A', ops: [maliciousOp] };
    ws.send(JSON.stringify(pushMsg));

    // The op passes validation (it has all required fields) so we do get an ack,
    // but the op should not appear in subsequent pulls because it was skipped in mergeOps
    const ack = await waitForMessage(ws);
    expect(ack.type).toBe('ack');

    // Now pull and verify the __proto__ op is not in oplog
    ws.send(JSON.stringify({ type: 'pull', clientId: 'client-A' }));
    const opsResponse = await waitForMessage(ws);
    const opIds = (opsResponse.ops ?? []).map((o) => o.id);
    expect(opIds).not.toContain('proto-op');

    await closeClient(ws);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe('Rate limiting', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port, maxMessagesPerSecond: 3 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('exceeding rate limit returns an error-like ack message', async () => {
    const ws = await connectClient(port);
    const clientId = 'rate-test-client';

    const responses: SyncMessage[] = [];
    ws.on('message', (data) => {
      responses.push(JSON.parse(data.toString()) as SyncMessage);
    });

    // Send more messages than the limit allows (limit = 3)
    for (let i = 0; i < 10; i++) {
      const op = makeOp({ id: `rate-op-${i}`, clientId });
      ws.send(JSON.stringify({ type: 'push', clientId, ops: [op] }));
    }

    await new Promise((r) => setTimeout(r, 300));
    await closeClient(ws);

    // At least one response should have an error field (rate limit exceeded)
    const rateLimitResponse = responses.find((r) => r.error === 'rate limit exceeded');
    expect(rateLimitResponse).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Token auth
// ---------------------------------------------------------------------------
describe('Token auth', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port, token: 'secret-token' });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('connection without valid token is rejected', async () => {
    await expect(connectClient(port)).rejects.toThrow();
  });

  it('connection with wrong token is rejected', async () => {
    await expect(connectClient(port, 'wrong-token')).rejects.toThrow();
  });

  it('connection with valid token succeeds', async () => {
    const ws = await connectClient(port, 'secret-token');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeClient(ws);
  });
});

// ---------------------------------------------------------------------------
// O(1) dedup
// ---------------------------------------------------------------------------
describe('O(1) dedup', () => {
  let server: SyncServer;
  let port: number;

  beforeEach(async () => {
    port = randomPort();
    server = new SyncServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('duplicate op IDs are not added to oplog twice', async () => {
    const ws = await connectClient(port);
    const op = makeOp({ id: 'dedup-op-1' });

    // Push the same op twice
    ws.send(JSON.stringify({ type: 'push', clientId: 'client-A', ops: [op] }));
    await waitForMessage(ws); // ack 1
    ws.send(JSON.stringify({ type: 'push', clientId: 'client-A', ops: [op] }));
    await waitForMessage(ws); // ack 2

    // Pull to inspect oplog
    ws.send(JSON.stringify({ type: 'pull', clientId: 'client-A' }));
    const opsResponse = await waitForMessage(ws);
    const matchingOps = (opsResponse.ops ?? []).filter((o) => o.id === 'dedup-op-1');
    expect(matchingOps).toHaveLength(1);

    await closeClient(ws);
  });
});
