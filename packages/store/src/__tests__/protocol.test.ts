import { describe, it, expect } from 'vitest';
import {
  encodeSyncMessage,
  decodeSyncMessage,
  createPullMessage,
  createPushMessage,
  createAckMessage,
} from '../sync/protocol.js';
import type { SyncMessage, Operation } from '../types.js';

function makeOp(id = 'op-1'): Operation {
  return {
    id,
    type: 'put',
    collection: 'items',
    docId: 'doc-1',
    fields: { name: 'test' },
    hlc: { ts: 1000, counter: 0, node: 'node-1' },
    clientId: 'client-1',
  };
}

// ---------------------------------------------------------------------------
// encode / decode roundtrip
// ---------------------------------------------------------------------------
describe('encodeSyncMessage / decodeSyncMessage roundtrip', () => {
  it('roundtrips a pull message', () => {
    const msg: SyncMessage = { type: 'pull', clientId: 'c1', since: '1000:0:n' };
    const decoded = decodeSyncMessage(encodeSyncMessage(msg));
    expect(decoded.type).toBe('pull');
    expect(decoded.clientId).toBe('c1');
    expect(decoded.since).toBe('1000:0:n');
  });

  it('roundtrips a push message with ops', () => {
    const msg: SyncMessage = { type: 'push', clientId: 'c1', ops: [makeOp()] };
    const decoded = decodeSyncMessage(encodeSyncMessage(msg));
    expect(decoded.type).toBe('push');
    expect(decoded.ops).toHaveLength(1);
    expect(decoded.ops![0].id).toBe('op-1');
  });

  it('roundtrips an ack message', () => {
    const msg: SyncMessage = { type: 'ack', clientId: 'server', ackId: 'op-42' };
    const decoded = decodeSyncMessage(encodeSyncMessage(msg));
    expect(decoded.type).toBe('ack');
    expect(decoded.ackId).toBe('op-42');
  });

  it('roundtrips an error message', () => {
    const msg: SyncMessage = { type: 'error', clientId: 'server', error: 'bad input' };
    const decoded = decodeSyncMessage(encodeSyncMessage(msg));
    expect(decoded.error).toBe('bad input');
  });
});

// ---------------------------------------------------------------------------
// decodeSyncMessage validation
// ---------------------------------------------------------------------------
describe('decodeSyncMessage validation', () => {
  it('throws on invalid JSON', () => {
    expect(() => decodeSyncMessage('not json {')).toThrow();
  });

  it('throws when type field is missing', () => {
    expect(() => decodeSyncMessage(JSON.stringify({ clientId: 'c1' }))).toThrow(
      /missing type/i,
    );
  });

  it('throws when clientId field is missing', () => {
    expect(() => decodeSyncMessage(JSON.stringify({ type: 'pull' }))).toThrow(
      /missing clientId/i,
    );
  });

  it('throws when parsed value is not an object', () => {
    expect(() => decodeSyncMessage(JSON.stringify(42))).toThrow();
  });

  it('throws when parsed value is null', () => {
    expect(() => decodeSyncMessage('null')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createPullMessage
// ---------------------------------------------------------------------------
describe('createPullMessage', () => {
  it('has type pull and the given clientId', () => {
    const msg = createPullMessage('client-abc');
    expect(msg.type).toBe('pull');
    expect(msg.clientId).toBe('client-abc');
  });

  it('includes since when provided', () => {
    const msg = createPullMessage('client-abc', '1000:0:n');
    expect(msg.since).toBe('1000:0:n');
  });

  it('since is undefined when not provided', () => {
    const msg = createPullMessage('client-abc');
    expect(msg.since).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPushMessage
// ---------------------------------------------------------------------------
describe('createPushMessage', () => {
  it('has type push and includes the given ops', () => {
    const ops = [makeOp('op-1'), makeOp('op-2')];
    const msg = createPushMessage('client-abc', ops);
    expect(msg.type).toBe('push');
    expect(msg.clientId).toBe('client-abc');
    expect(msg.ops).toHaveLength(2);
    expect(msg.ops![0].id).toBe('op-1');
    expect(msg.ops![1].id).toBe('op-2');
  });

  it('accepts empty ops array', () => {
    const msg = createPushMessage('client-abc', []);
    expect(msg.ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAckMessage
// ---------------------------------------------------------------------------
describe('createAckMessage', () => {
  it('has type ack with the given clientId and ackId', () => {
    const msg = createAckMessage('server', 'op-xyz');
    expect(msg.type).toBe('ack');
    expect(msg.clientId).toBe('server');
    expect(msg.ackId).toBe('op-xyz');
  });
});
