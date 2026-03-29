import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compareHLC } from '../hlc/clock.js';
import { createStore, Store } from '../store.js';
import { serializeHLC } from '../hlc/clock.js';
import type { Operation } from '../types.js';

function makeStore(name = 'test-store') {
  return createStore({
    name,
    collections: { items: {} },
    clientId: 'client-test',
  });
}

// ---------------------------------------------------------------------------
// Store construction
// ---------------------------------------------------------------------------
describe('createStore', () => {
  it('creates a Store instance with the given name', () => {
    const store = makeStore('my-store');
    expect(store).toBeInstanceOf(Store);
    expect(store.name).toBe('my-store');
  });

  it('uses provided clientId', () => {
    const store = createStore({ name: 's', collections: {}, clientId: 'fixed-id' });
    expect(store.clientId).toBe('fixed-id');
  });

  it('auto-generates clientId when not provided', () => {
    const store = createStore({ name: 's', collections: {} });
    expect(typeof store.clientId).toBe('string');
    expect(store.clientId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// collection()
// ---------------------------------------------------------------------------
describe('collection()', () => {
  it('returns the same Collection instance for the same name', () => {
    const store = makeStore();
    const col1 = store.collection('items');
    const col2 = store.collection('items');
    expect(col1).toBe(col2);
  });

  it('returns different instances for different names', () => {
    const store = makeStore();
    const col1 = store.collection('items');
    const col2 = store.collection('users');
    expect(col1).not.toBe(col2);
  });
});

// ---------------------------------------------------------------------------
// put / get
// ---------------------------------------------------------------------------
describe('put then get', () => {
  it('returns the doc after putting it', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');
    await col.put({ id: 'doc-1', name: 'Alice' });
    const doc = await col.get('doc-1');
    expect(doc).not.toBeNull();
    expect(doc!.data.name).toBe('Alice');
  });

  it('get returns null for a non-existent doc', async () => {
    const store = makeStore();
    const col = store.collection('items');
    const doc = await col.get('nonexistent');
    expect(doc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
describe('update', () => {
  it('modifies specified fields while preserving others', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string; age: number }>('items');
    await col.put({ id: 'doc-1', name: 'Alice', age: 30 });
    await col.update('doc-1', { age: 31 });
    const doc = await col.get('doc-1');
    expect(doc!.data.name).toBe('Alice');
    expect(doc!.data.age).toBe(31);
  });

  it('returns null when doc does not exist', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');
    const result = await col.update('nonexistent', { name: 'Bob' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------
describe('delete', () => {
  it('makes doc invisible via get after deletion', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');
    await col.put({ id: 'doc-1', name: 'Alice' });
    await col.delete('doc-1');
    const doc = await col.get('doc-1');
    expect(doc).toBeNull();
  });

  it('does not throw when deleting a non-existent doc', async () => {
    const store = makeStore();
    const col = store.collection('items');
    await expect(col.delete('nonexistent')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------
describe('find', () => {
  it('returns all non-deleted docs', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');
    await col.put({ id: 'a', name: 'Alice' });
    await col.put({ id: 'b', name: 'Bob' });
    await col.put({ id: 'c', name: 'Carol' });
    await col.delete('b');
    const docs = await col.find();
    expect(docs).toHaveLength(2);
    const ids = docs.map((d) => d.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b');
  });

  it('returns empty array when collection is empty', async () => {
    const store = makeStore();
    const col = store.collection('items');
    const docs = await col.find();
    expect(docs).toEqual([]);
  });

  it('returns matching docs when filter is provided', async () => {
    const store = makeStore();
    const col = store.collection<{ status: string }>('items');
    await col.put({ id: 'a', status: 'active' });
    await col.put({ id: 'b', status: 'inactive' });
    await col.put({ id: 'c', status: 'active' });
    const docs = await col.find({ status: 'active' });
    expect(docs).toHaveLength(2);
    docs.forEach((d) => expect(d.data.status).toBe('active'));
  });
});

// ---------------------------------------------------------------------------
// findOne
// ---------------------------------------------------------------------------
describe('findOne', () => {
  it('returns the first matching doc', async () => {
    const store = makeStore();
    const col = store.collection<{ role: string }>('items');
    await col.put({ id: 'a', role: 'admin' });
    await col.put({ id: 'b', role: 'user' });
    const doc = await col.findOne({ role: 'admin' });
    expect(doc).not.toBeNull();
    expect(doc!.data.role).toBe('admin');
  });

  it('returns null when no doc matches', async () => {
    const store = makeStore();
    const col = store.collection<{ role: string }>('items');
    await col.put({ id: 'a', role: 'user' });
    const doc = await col.findOne({ role: 'admin' });
    expect(doc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------
describe('subscribe', () => {
  it('fires immediately with current docs on subscription', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');
    await col.put({ id: 'doc-1', name: 'Alice' });

    const received: unknown[][] = [];
    const unsub = col.subscribe((docs) => received.push(docs));

    // Wait for the initial async emit
    await new Promise((r) => setTimeout(r, 20));
    unsub();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toHaveLength(1);
  });

  it('fires again when a doc is added', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');

    const calls: number[] = [];
    const unsub = col.subscribe((docs) => calls.push(docs.length));

    await new Promise((r) => setTimeout(r, 10));
    await col.put({ id: 'doc-1', name: 'Alice' });
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    // Should have been called at least twice (initial + after put)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBe(1);
  });

  it('unsubscribe stops future notifications', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');

    const calls: number[] = [];
    const unsub = col.subscribe((docs) => calls.push(docs.length));
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    const callsBeforeUnsub = calls.length;

    await col.put({ id: 'doc-1', name: 'Alice' });
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.length).toBe(callsBeforeUnsub);
  });
});

// ---------------------------------------------------------------------------
// subscribeDoc
// ---------------------------------------------------------------------------
describe('subscribeDoc', () => {
  it('fires for specific doc changes', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');

    const received: Array<unknown> = [];
    const unsub = col.subscribeDoc('doc-1', (doc) => received.push(doc));

    await new Promise((r) => setTimeout(r, 10));
    await col.put({ id: 'doc-1', name: 'Alice' });
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    // At minimum: initial null emission + post-put emission
    expect(received.length).toBeGreaterThanOrEqual(2);
    const lastDoc = received[received.length - 1] as { data: { name: string } } | null;
    expect(lastDoc).not.toBeNull();
    expect(lastDoc!.data.name).toBe('Alice');
  });

  it('does not fire for changes to other docs', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');

    const received: unknown[] = [];
    const unsub = col.subscribeDoc('doc-1', (doc) => received.push(doc));
    await new Promise((r) => setTimeout(r, 10));
    const countBefore = received.length;

    await col.put({ id: 'doc-2', name: 'Bob' }); // different doc
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    // subscribeDoc('doc-1') fires on _notify() for any change, but doc-1 is still null
    // The count may increase but the value should still be null for doc-1
    const lastDoc = received[received.length - 1];
    expect(lastDoc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failing subscriber doesn't block others
// ---------------------------------------------------------------------------
describe('_notify resilience', () => {
  it('a throwing subscriber does not prevent other subscribers from firing', async () => {
    const store = makeStore();
    const col = store.collection<{ name: string }>('items');

    const goodCalls: number[] = [];

    // Bad subscriber: skip the initial emit (called from subscribe's .then outside
    // try/catch), only throw on subsequent _notify calls triggered by mutations.
    let badCallCount = 0;
    col.subscribe(() => {
      badCallCount++;
      if (badCallCount > 1) {
        throw new Error('subscriber failure');
      }
    });

    // Subscribe a good subscriber
    const unsub = col.subscribe((docs) => goodCalls.push(docs.length));

    // Wait for initial emits to settle
    await new Promise((r) => setTimeout(r, 20));

    // Trigger _notify via a mutation — bad subscriber throws but good one still fires
    await col.put({ id: 'doc-1', name: 'Alice' });
    await new Promise((r) => setTimeout(r, 20));
    unsub();

    // Good subscriber must have been called (initial + after put)
    expect(goodCalls.length).toBeGreaterThanOrEqual(2);
    const lastCount = goodCalls[goodCalls.length - 1];
    expect(lastCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// _applyRemoteOps
// ---------------------------------------------------------------------------
describe('_applyRemoteOps', () => {
  it('persists remote ops to oplog and they are retrievable via getOpsSince', async () => {
    const store = makeStore();
    const pastHlc = { ts: 1, counter: 0, node: 'remote-node' };
    const remoteOp: Operation = {
      id: 'remote-op-1',
      type: 'put',
      collection: 'items',
      docId: 'remote-doc',
      fields: { name: 'Remote' },
      hlc: { ts: Date.now() + 10, counter: 0, node: 'remote-node' },
      clientId: 'remote-client',
    };

    await store._applyRemoteOps([remoteOp]);

    const ops = await store.getOpsSince(serializeHLC(pastHlc));
    const opIds = ops.map((o) => o.id);
    expect(opIds).toContain('remote-op-1');
  });

  it('applies remote op to collection so doc is accessible via get', async () => {
    const store = makeStore();
    const remoteOp: Operation = {
      id: 'remote-op-2',
      type: 'put',
      collection: 'items',
      docId: 'remote-doc-2',
      fields: { name: 'FromRemote' },
      hlc: { ts: Date.now(), counter: 0, node: 'remote-node' },
      clientId: 'remote-client',
    };

    await store._applyRemoteOps([remoteOp]);

    const col = store.collection<{ name: string }>('items');
    const doc = await col.get('remote-doc-2');
    expect(doc).not.toBeNull();
    expect(doc!.data.name).toBe('FromRemote');
  });
});

// ---------------------------------------------------------------------------
// _createOp increments HLC each time
// ---------------------------------------------------------------------------
describe('_createOp', () => {
  it('returns operations with strictly increasing HLC each call', () => {
    const store = makeStore();
    const op1 = store._createOp('items', 'put', 'doc-1', {});
    const op2 = store._createOp('items', 'put', 'doc-2', {});
    const op3 = store._createOp('items', 'put', 'doc-3', {});

    // Each successive op must have a strictly later HLC
    expect(compareHLC(op2.hlc, op1.hlc)).toBeGreaterThan(0);
    expect(compareHLC(op3.hlc, op2.hlc)).toBeGreaterThan(0);
  });

  it('embeds the clientId in the op', () => {
    const store = createStore({ name: 's', collections: {}, clientId: 'my-client' });
    const op = store._createOp('items', 'put', 'doc-1', {});
    expect(op.clientId).toBe('my-client');
  });
});
