import type {
  StoreConfig,
  StorageAdapter,
  SyncConfig,
  HLC,
  Operation,
  OpType,
} from './types.js';
import { Collection } from './collection.js';
import {
  createHLC,
  generateNodeId,
  increment,
  receive,
  serializeHLC,
} from './hlc/clock.js';
import { SyncClient } from './sync/client.js';

export class Store {
  readonly name: string;
  readonly clientId: string;
  private collections = new Map<string, Collection<Record<string, unknown>>>();
  private storage: StorageAdapter;
  private clock: HLC;
  private syncClient?: SyncClient;

  constructor(config: StoreConfig) {
    this.name = config.name;
    this.clientId = config.clientId ?? generateNodeId();
    this.clock = createHLC(this.clientId);

    if (config.storage) {
      this.storage = config.storage;
    } else {
      // Import MemoryAdapter lazily to avoid circular deps at module load
      // For MVP, use a simple inline memory adapter
      this.storage = createMemoryAdapter();
    }

    // Pre-create declared collections
    for (const colName of Object.keys(config.collections)) {
      this._getOrCreateCollection(colName);
    }
  }

  collection<T extends Record<string, unknown>>(name: string): Collection<T> {
    return this._getOrCreateCollection(name) as Collection<T>;
  }

  sync(urlOrConfig: string | SyncConfig): void {
    const config: SyncConfig =
      typeof urlOrConfig === 'string' ? { url: urlOrConfig } : urlOrConfig;
    this.syncClient = new SyncClient(config, this.clientId, {
      onRemoteOps: (ops) => this._applyRemoteOps(ops),
      getUnsyncedOps: () => this.storage.getUnsyncedOps(),
      getLastSyncHLC: () => undefined,
    });
    this.syncClient.connect();
  }

  disconnect(): void {
    this.syncClient?.disconnect();
    this.syncClient = undefined;
  }

  async getOpsSince(since: string): Promise<Operation[]> {
    return this.storage.getOpsSince(since);
  }

  async _applyRemoteOps(ops: Operation[]): Promise<void> {
    for (const op of ops) {
      // Advance our clock to stay ahead of remote
      this.clock = receive(this.clock, op.hlc);
      const col = this._getOrCreateCollection(op.collection);
      await col._applyRemoteOp(op);
    }
    // Persist ops to oplog then mark as synced
    await this.storage.appendOps(ops);
    await this.storage.markSynced(ops.map((o) => o.id));
  }

  async _getUnsyncedOps(): Promise<Operation[]> {
    return this.storage.getUnsyncedOps();
  }

  _pushOps(ops: Operation[]): void {
    this.syncClient?.pushOps(ops);
  }

  _createOp(
    collection: string,
    type: OpType,
    docId: string,
    fields?: Record<string, unknown>,
  ): Operation {
    this.clock = increment(this.clock);
    return {
      id: `${this.clientId}-${serializeHLC(this.clock)}`,
      type,
      collection,
      docId,
      fields,
      hlc: { ...this.clock },
      clientId: this.clientId,
    };
  }

  private _getOrCreateCollection(name: string): Collection<Record<string, unknown>> {
    if (!this.collections.has(name)) {
      const col = new Collection<Record<string, unknown>>(
        name,
        this.storage,
        (type, docId, fields) => this._createOp(name, type, docId, fields),
        (ops) => this._pushOps(ops),
      );
      this.collections.set(name, col);
    }
    return this.collections.get(name)!;
  }
}

export function createStore(config: StoreConfig): Store {
  return new Store(config);
}

// ---------------------------------------------------------------------------
// Inline MemoryAdapter (used when no storage is provided)
// ---------------------------------------------------------------------------

interface MemoryOp extends Operation {
  _synced?: boolean;
}

function createMemoryAdapter(): StorageAdapter {
  const docs = new Map<string, Doc>();
  const ops: MemoryOp[] = [];

  function key(collection: string, id: string): string {
    return `${collection}::${id}`;
  }

  return {
    async getDoc(collection, id) {
      return docs.get(key(collection, id)) ?? null;
    },
    async getAllDocs(collection) {
      const prefix = `${collection}::`;
      const result: Doc[] = [];
      for (const [k, v] of docs) {
        if (k.startsWith(prefix)) result.push(v);
      }
      return result;
    },
    async putDoc(collection, doc) {
      docs.set(key(collection, doc.id), doc);
    },
    async deleteDoc(collection, id, version) {
      const existing = docs.get(key(collection, id));
      if (existing) {
        docs.set(key(collection, id), { ...existing, _deleted: true, _version: version });
      }
    },
    async appendOps(newOps) {
      for (const op of newOps) {
        ops.push({ ...op, _synced: false });
      }
    },
    async getOpsSince(since) {
      if (!since) return [...ops];
      // Parse since as serialized HLC and filter
      const { deserializeHLC } = await import('./hlc/clock.js');
      const sinceHlc = deserializeHLC(since);
      const { compareHLC } = await import('./hlc/clock.js');
      return ops.filter((op) => compareHLC(op.hlc, sinceHlc) > 0);
    },
    async getUnsyncedOps() {
      return ops.filter((op) => !op._synced);
    },
    async markSynced(opIds) {
      const idSet = new Set(opIds);
      for (const op of ops) {
        if (idSet.has(op.id)) op._synced = true;
      }
    },
    async clear() {
      docs.clear();
      ops.length = 0;
    },
  };
}

// Local type alias to avoid importing Doc in this file scope
type Doc = import('./types.js').Doc;
