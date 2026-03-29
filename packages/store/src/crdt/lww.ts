import type { Doc, Operation } from '../types.js';
import { compareHLC } from '../hlc/clock.js';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function applyPut<T extends Record<string, unknown>>(existing: Doc<T> | null, op: Operation): Doc<T> {
  const raw = (op.fields ?? {}) as Record<string, unknown>;
  const fields = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !BLOCKED_KEYS.has(k))
  ) as T;
  // If existing doc has a later version, keep it (LWW)
  if (existing !== null && !existing._deleted && compareHLC(existing._version, op.hlc) > 0) {
    return existing;
  }
  return {
    id: op.docId,
    _version: op.hlc,
    _deleted: false,
    _updatedAt: op.hlc.ts,
    data: fields,
  };
}

export function applyUpdate<T extends Record<string, unknown>>(existing: Doc<T> | null, op: Operation): Doc<T> {
  const incomingFields = op.fields ?? {};
  if (existing === null) {
    // No existing doc — treat as put
    return {
      id: op.docId,
      _version: op.hlc,
      _deleted: false,
      _updatedAt: op.hlc.ts,
      data: incomingFields as T,
    };
  }

  // Field-level LWW: for each field in op.fields, only apply if op.hlc is later
  const merged = { ...(existing.data as Record<string, unknown>) };
  if (compareHLC(op.hlc, existing._version) > 0) {
    for (const key of Object.keys(incomingFields)) {
      if (BLOCKED_KEYS.has(key)) continue;
      merged[key] = incomingFields[key];
    }
  }

  const newVersion = compareHLC(op.hlc, existing._version) > 0 ? op.hlc : existing._version;
  const updatedAt = compareHLC(op.hlc, existing._version) > 0 ? op.hlc.ts : existing._updatedAt;

  return {
    id: op.docId,
    _version: newVersion,
    _deleted: false,
    _updatedAt: updatedAt,
    data: merged as T,
  };
}

export function applyDelete<T extends Record<string, unknown>>(existing: Doc<T> | null, op: Operation): Doc<T> {
  if (existing !== null && compareHLC(existing._version, op.hlc) > 0) {
    // Existing doc is newer — keep it as-is
    return existing;
  }
  const base = existing ?? {
    id: op.docId,
    _version: op.hlc,
    _deleted: false,
    _updatedAt: op.hlc.ts,
    data: {} as T,
  };
  return {
    ...base,
    _version: op.hlc,
    _deleted: true,
    _updatedAt: op.hlc.ts,
  };
}

export function applyOperation<T extends Record<string, unknown>>(existing: Doc<T> | null, op: Operation): Doc<T> {
  switch (op.type) {
    case 'put':
      return applyPut(existing, op);
    case 'update':
      return applyUpdate(existing, op);
    case 'delete':
      return applyDelete(existing, op);
  }
}

export function mergeDoc<T extends Record<string, unknown>>(a: Doc<T>, b: Doc<T>): Doc<T> {
  // Field-level LWW: the doc with later _version wins for all fields
  if (compareHLC(a._version, b._version) > 0) {
    return a;
  }
  if (compareHLC(b._version, a._version) > 0) {
    return b;
  }
  // Identical version — return a
  return a;
}
