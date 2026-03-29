import type { StorageAdapter, Doc, Operation, HLC } from '../types.js';
import { serializeHLC, compareHLC, deserializeHLC } from '../hlc/clock.js';

interface MemoryOp extends Operation {
  synced: boolean;
}

export class MemoryAdapter implements StorageAdapter {
  private docs = new Map<string, Map<string, Doc>>();
  private oplog: MemoryOp[] = [];

  async getDoc(collection: string, id: string): Promise<Doc | null> {
    return this.docs.get(collection)?.get(id) ?? null;
  }

  async getAllDocs(collection: string): Promise<Doc[]> {
    const col = this.docs.get(collection);
    if (!col) return [];
    return Array.from(col.values());
  }

  async putDoc(collection: string, doc: Doc): Promise<void> {
    if (!this.docs.has(collection)) {
      this.docs.set(collection, new Map());
    }
    this.docs.get(collection)!.set(doc.id, doc);
  }

  async deleteDoc(collection: string, id: string, version: HLC): Promise<void> {
    const existing = this.docs.get(collection)?.get(id);
    if (existing) {
      this.docs.get(collection)!.set(id, {
        ...existing,
        _deleted: true,
        _version: version,
        _updatedAt: version.ts,
      });
    }
  }

  async appendOps(ops: Operation[]): Promise<void> {
    for (const op of ops) {
      this.oplog.push({ ...op, synced: false });
    }
  }

  async getOpsSince(since: string): Promise<Operation[]> {
    if (!since) return this.oplog.map(({ synced: _s, ...op }) => op);
    const sinceHlc = deserializeHLC(since);
    return this.oplog
      .filter((op) => compareHLC(op.hlc, sinceHlc) > 0)
      .map(({ synced: _s, ...op }) => op);
  }

  async getUnsyncedOps(): Promise<Operation[]> {
    return this.oplog
      .filter((op) => !op.synced)
      .map(({ synced: _s, ...op }) => op);
  }

  async markSynced(opIds: string[]): Promise<void> {
    const idSet = new Set(opIds);
    for (const op of this.oplog) {
      if (idSet.has(op.id)) {
        op.synced = true;
      }
    }
  }

  async clear(): Promise<void> {
    this.docs.clear();
    this.oplog.length = 0;
  }
}

// Re-export to satisfy import in case callers use serializeHLC from here
export { serializeHLC, compareHLC };
