import { describe, it, expect, beforeEach } from 'vitest';
import {
  createHLC,
  increment,
  receive,
  compareHLC,
  serializeHLC,
  deserializeHLC,
  generateNodeId,
  MAX_DRIFT_MS,
} from '../hlc/clock.js';
import type { HLC } from '../types.js';

describe('createHLC', () => {
  it('returns valid HLC with the given node', () => {
    const hlc = createHLC('node-1');
    expect(hlc.node).toBe('node-1');
    expect(typeof hlc.ts).toBe('number');
    expect(hlc.counter).toBe(0);
  });

  it('sets ts close to current wall clock', () => {
    const before = Date.now();
    const hlc = createHLC('node-1');
    const after = Date.now();
    expect(hlc.ts).toBeGreaterThanOrEqual(before);
    expect(hlc.ts).toBeLessThanOrEqual(after);
  });
});

describe('increment', () => {
  it('advances counter when wall clock equals hlc.ts', () => {
    const base: HLC = { ts: Date.now() + 100_000, counter: 5, node: 'n1' };
    const next = increment(base);
    expect(next.ts).toBe(base.ts);
    expect(next.counter).toBe(6);
    expect(next.node).toBe('n1');
  });

  it('resets counter to 0 when wall clock is newer than hlc.ts', () => {
    // ts far in the past so Date.now() > base.ts
    const base: HLC = { ts: 1, counter: 99, node: 'n1' };
    const next = increment(base);
    expect(next.ts).toBeGreaterThan(base.ts);
    expect(next.counter).toBe(0);
  });

  it('preserves node on increment', () => {
    const base: HLC = { ts: 1, counter: 0, node: 'my-node' };
    const next = increment(base);
    expect(next.node).toBe('my-node');
  });
});

describe('receive', () => {
  it('takes the max of local ts, remote ts, and now', () => {
    const local: HLC = { ts: 1000, counter: 0, node: 'local' };
    const remote: HLC = { ts: 2000, counter: 0, node: 'remote' };
    const result = receive(local, remote);
    // result.ts must be >= max(1000, 2000) == 2000
    expect(result.ts).toBeGreaterThanOrEqual(2000);
  });

  it('increments counter when remote ts equals local ts and both equal now', () => {
    // Set both local and remote ts equal to each other and to now by using
    // the real Date.now() value — we freeze it via a fixed past value that
    // will be less than real now, so now wins and counter resets to 0.
    // Instead, verify the case where ts == local.ts == remote.ts by checking
    // that when local and remote share the same ts the counter advances.
    // We verify the logic directly: counter = max(local.counter, remote.counter)+1
    // when ts === local.ts === remote.ts. Use a ts in the future just below drift.
    const ts = Date.now() + MAX_DRIFT_MS - 5000; // within drift limit
    const local: HLC = { ts, counter: 3, node: 'local' };
    const remote: HLC = { ts, counter: 5, node: 'remote' };
    const result = receive(local, remote);
    expect(result.ts).toBe(ts);
    expect(result.counter).toBe(6); // max(3,5)+1
  });

  it('increments local counter when local ts wins over remote', () => {
    // Use a ts in the near future (within drift) so wall clock < ts
    const ts = Date.now() + MAX_DRIFT_MS - 5000;
    const local: HLC = { ts, counter: 7, node: 'local' };
    const remote: HLC = { ts: ts - 1000, counter: 99, node: 'remote' };
    const result = receive(local, remote);
    expect(result.ts).toBe(ts);
    expect(result.counter).toBe(8); // local.counter+1
    expect(result.node).toBe('local');
  });

  it('increments remote counter when remote ts wins over local', () => {
    // remote.ts > local.ts, remote within drift limit
    const ts = Date.now() + MAX_DRIFT_MS - 5000;
    const local: HLC = { ts: ts - 1000, counter: 99, node: 'local' };
    const remote: HLC = { ts, counter: 4, node: 'remote' };
    const result = receive(local, remote);
    expect(result.ts).toBe(ts);
    expect(result.counter).toBe(5); // remote.counter+1
  });

  it('throws when remote drift exceeds MAX_DRIFT_MS', () => {
    const local: HLC = { ts: Date.now(), counter: 0, node: 'local' };
    const remote: HLC = { ts: Date.now() + MAX_DRIFT_MS + 1000, counter: 0, node: 'remote' };
    expect(() => receive(local, remote)).toThrow(/drift/i);
  });

  it('preserves local node in result', () => {
    const local: HLC = { ts: 1, counter: 0, node: 'local-node' };
    const remote: HLC = { ts: 2, counter: 0, node: 'remote-node' };
    const result = receive(local, remote);
    expect(result.node).toBe('local-node');
  });
});

describe('compareHLC', () => {
  it('orders by ts first: smaller ts comes first', () => {
    const a: HLC = { ts: 100, counter: 9, node: 'z' };
    const b: HLC = { ts: 200, counter: 0, node: 'a' };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it('orders by counter when ts is equal', () => {
    const a: HLC = { ts: 100, counter: 1, node: 'z' };
    const b: HLC = { ts: 100, counter: 2, node: 'a' };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it('orders by node string when ts and counter are equal', () => {
    const a: HLC = { ts: 100, counter: 1, node: 'alpha' };
    const b: HLC = { ts: 100, counter: 1, node: 'beta' };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for identical HLCs', () => {
    const a: HLC = { ts: 100, counter: 1, node: 'same' };
    const b: HLC = { ts: 100, counter: 1, node: 'same' };
    expect(compareHLC(a, b)).toBe(0);
  });
});

describe('serializeHLC / deserializeHLC roundtrip', () => {
  it('roundtrips a simple HLC', () => {
    const hlc: HLC = { ts: 1711700000000, counter: 42, node: 'node-abc' };
    const serialized = serializeHLC(hlc);
    const deserialized = deserializeHLC(serialized);
    expect(deserialized.ts).toBe(hlc.ts);
    expect(deserialized.counter).toBe(hlc.counter);
    expect(deserialized.node).toBe(hlc.node);
  });

  it('roundtrips a node id that contains colons', () => {
    const hlc: HLC = { ts: 1000, counter: 0, node: 'a:b:c' };
    const serialized = serializeHLC(hlc);
    const deserialized = deserializeHLC(serialized);
    expect(deserialized.node).toBe('a:b:c');
  });

  it('serialized form contains ts, counter, and node separated by colons', () => {
    const hlc: HLC = { ts: 9999, counter: 3, node: 'n1' };
    const serialized = serializeHLC(hlc);
    expect(serialized).toBe('9999:3:n1');
  });
});

describe('generateNodeId', () => {
  it('returns a non-empty string', () => {
    const id = generateNodeId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns unique strings on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateNodeId()));
    expect(ids.size).toBe(100);
  });
});
