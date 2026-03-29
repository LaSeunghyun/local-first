import type { HLC } from '../types.js';

export function generateNodeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createHLC(node: string): HLC {
  return { ts: Date.now(), counter: 0, node };
}

export function increment(clock: HLC): HLC {
  const now = Date.now();
  const ts = Math.max(now, clock.ts);
  const counter = ts === clock.ts ? clock.counter + 1 : 0;
  return { ts, counter, node: clock.node };
}

export const MAX_DRIFT_MS = 60_000;

export function receive(local: HLC, remote: HLC): HLC {
  const now = Date.now();
  if (remote.ts - now > MAX_DRIFT_MS) {
    throw new Error(`Remote clock drift exceeds ${MAX_DRIFT_MS}ms (remote: ${remote.ts}, now: ${now})`);
  }
  const ts = Math.max(local.ts, remote.ts, now);
  let counter: number;
  if (ts === local.ts && ts === remote.ts) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (ts === local.ts) {
    counter = local.counter + 1;
  } else if (ts === remote.ts) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { ts, counter, node: local.node };
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.node < b.node) return -1;
  if (a.node > b.node) return 1;
  return 0;
}

export function serializeHLC(hlc: HLC): string {
  return `${hlc.ts}:${hlc.counter}:${hlc.node}`;
}

export function deserializeHLC(s: string): HLC {
  const idx1 = s.indexOf(':');
  const idx2 = s.indexOf(':', idx1 + 1);
  const ts = parseInt(s.slice(0, idx1), 10);
  const counter = parseInt(s.slice(idx1 + 1, idx2), 10);
  const node = s.slice(idx2 + 1);
  return { ts, counter, node };
}
