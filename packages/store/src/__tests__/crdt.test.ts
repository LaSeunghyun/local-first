import { describe, it, expect } from 'vitest';
import {
  applyPut,
  applyUpdate,
  applyDelete,
  applyOperation,
  mergeDoc,
} from '../crdt/lww.js';
import type { Doc, Operation } from '../types.js';
import type { HLC } from '../types.js';

function makeHLC(ts: number, counter = 0, node = 'node-1'): HLC {
  return { ts, counter, node };
}

function makeOp(
  overrides: Partial<Operation> & { hlcTs?: number; hlcCounter?: number },
): Operation {
  const { hlcTs = 1000, hlcCounter = 0, ...rest } = overrides;
  return {
    id: 'op-1',
    type: 'put',
    collection: 'items',
    docId: 'doc-1',
    fields: {},
    hlc: makeHLC(hlcTs, hlcCounter),
    clientId: 'client-1',
    ...rest,
  };
}

function makeDoc<T extends Record<string, unknown>>(
  data: T,
  ts = 1000,
  counter = 0,
): Doc<T> {
  return {
    id: 'doc-1',
    _version: makeHLC(ts, counter),
    _deleted: false,
    _updatedAt: ts,
    data,
  };
}

// ---------------------------------------------------------------------------
// applyPut
// ---------------------------------------------------------------------------
describe('applyPut', () => {
  it('creates a new doc from null', () => {
    const op = makeOp({ fields: { name: 'Alice' }, hlcTs: 1000 });
    const result = applyPut(null, op);
    expect(result.id).toBe('doc-1');
    expect(result._deleted).toBe(false);
    expect(result.data).toEqual({ name: 'Alice' });
  });

  it('keeps existing doc when existing version is newer (LWW)', () => {
    const existing = makeDoc({ name: 'Alice' }, 2000);
    const op = makeOp({ fields: { name: 'Bob' }, hlcTs: 1000 }); // older op
    const result = applyPut(existing, op);
    expect(result.data).toEqual({ name: 'Alice' });
  });

  it('replaces existing doc when op version is newer', () => {
    const existing = makeDoc({ name: 'Alice' }, 1000);
    const op = makeOp({ fields: { name: 'Bob' }, hlcTs: 2000 }); // newer op
    const result = applyPut(existing, op);
    expect(result.data).toEqual({ name: 'Bob' });
  });

  it('filters out __proto__ key from fields', () => {
    const op = makeOp({ fields: { __proto__: { polluted: true }, name: 'safe' } });
    const result = applyPut(null, op);
    expect(result.data).not.toHaveProperty('__proto__');
    expect(result.data).toHaveProperty('name', 'safe');
  });

  it('filters out constructor key from fields', () => {
    const op = makeOp({ fields: { constructor: 'evil', name: 'safe' } });
    const result = applyPut(null, op);
    expect(result.data).not.toHaveProperty('constructor');
  });

  it('filters out prototype key from fields', () => {
    const op = makeOp({ fields: { prototype: {}, name: 'safe' } });
    const result = applyPut(null, op);
    expect(result.data).not.toHaveProperty('prototype');
  });
});

// ---------------------------------------------------------------------------
// applyUpdate
// ---------------------------------------------------------------------------
describe('applyUpdate', () => {
  it('merges fields when op hlc is newer than existing version', () => {
    const existing = makeDoc({ name: 'Alice', age: 30 }, 1000);
    const op = makeOp({ type: 'update', fields: { age: 31 }, hlcTs: 2000 });
    const result = applyUpdate(existing, op);
    expect(result.data).toEqual({ name: 'Alice', age: 31 });
  });

  it('skips blocked keys (__proto__, constructor, prototype) in merge', () => {
    const existing = makeDoc({ name: 'Alice' }, 1000);
    const op = makeOp({
      type: 'update',
      fields: { __proto__: { evil: true }, name: 'Bob' },
      hlcTs: 2000,
    });
    const result = applyUpdate(existing, op);
    expect(result.data).not.toHaveProperty('__proto__');
    expect(result.data.name).toBe('Bob');
  });

  it('does not apply fields when op hlc is older than existing version', () => {
    const existing = makeDoc({ name: 'Alice', age: 30 }, 2000);
    const op = makeOp({ type: 'update', fields: { age: 99 }, hlcTs: 1000 }); // older
    const result = applyUpdate(existing, op);
    expect(result.data.age).toBe(30);
  });

  it('creates a new doc from null when no existing doc', () => {
    const op = makeOp({ type: 'update', fields: { name: 'Alice' }, hlcTs: 1000 });
    const result = applyUpdate(null, op);
    expect(result.id).toBe('doc-1');
    expect(result.data).toEqual({ name: 'Alice' });
  });
});

// ---------------------------------------------------------------------------
// applyDelete
// ---------------------------------------------------------------------------
describe('applyDelete', () => {
  it('tombstones an existing doc', () => {
    const existing = makeDoc({ name: 'Alice' }, 1000);
    const op = makeOp({ type: 'delete', hlcTs: 2000 });
    const result = applyDelete(existing, op);
    expect(result._deleted).toBe(true);
  });

  it('ignores delete op when it is older than the existing doc version', () => {
    const existing = makeDoc({ name: 'Alice' }, 2000);
    const op = makeOp({ type: 'delete', hlcTs: 1000 }); // older than existing
    const result = applyDelete(existing, op);
    expect(result._deleted).toBe(false);
  });

  it('creates a tombstoned doc from null', () => {
    const op = makeOp({ type: 'delete', hlcTs: 1000 });
    const result = applyDelete(null, op);
    expect(result._deleted).toBe(true);
    expect(result.id).toBe('doc-1');
  });
});

// ---------------------------------------------------------------------------
// mergeDoc
// ---------------------------------------------------------------------------
describe('mergeDoc', () => {
  it('returns the doc with the later _version', () => {
    const a = makeDoc({ name: 'Alice' }, 2000);
    const b = makeDoc({ name: 'Bob' }, 1000);
    const result = mergeDoc(a, b);
    expect(result.data.name).toBe('Alice');
  });

  it('returns b when b has later _version', () => {
    const a = makeDoc({ name: 'Alice' }, 1000);
    const b = makeDoc({ name: 'Bob' }, 2000);
    const result = mergeDoc(a, b);
    expect(result.data.name).toBe('Bob');
  });

  it('returns a when both versions are identical', () => {
    const a = makeDoc({ name: 'Alice' }, 1000);
    const b = makeDoc({ name: 'Bob' }, 1000);
    const result = mergeDoc(a, b);
    expect(result.data.name).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// applyOperation dispatcher
// ---------------------------------------------------------------------------
describe('applyOperation', () => {
  it('dispatches put type to applyPut', () => {
    const op = makeOp({ type: 'put', fields: { x: 1 }, hlcTs: 1000 });
    const result = applyOperation(null, op);
    expect(result.data).toEqual({ x: 1 });
    expect(result._deleted).toBe(false);
  });

  it('dispatches update type to applyUpdate', () => {
    const existing = makeDoc({ x: 1 }, 1000);
    const op = makeOp({ type: 'update', fields: { x: 2 }, hlcTs: 2000 });
    const result = applyOperation(existing, op);
    expect(result.data.x).toBe(2);
  });

  it('dispatches delete type to applyDelete', () => {
    const existing = makeDoc({ x: 1 }, 1000);
    const op = makeOp({ type: 'delete', hlcTs: 2000 });
    const result = applyOperation(existing, op);
    expect(result._deleted).toBe(true);
  });
});
