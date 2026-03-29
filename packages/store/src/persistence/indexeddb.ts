import type { StorageAdapter, Doc, Operation, HLC } from '../types.js';
import { deserializeHLC, compareHLC } from '../hlc/clock.js';

interface IDBOpEntry extends Operation {
  synced: boolean;
}

interface IDBDocEntry extends Doc {
  _key: string;
  _collection: string;
}

const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_OPLOG = 'oplog';

export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private initPromise: Promise<void>;

  constructor(dbName: string) {
    this.dbName = dbName;
    this.initPromise = this.init();
  }

  private init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_DOCS)) {
          const docsStore = db.createObjectStore(STORE_DOCS, { keyPath: '_key' });
          docsStore.createIndex('collection', '_collection', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_OPLOG)) {
          const oplogStore = db.createObjectStore(STORE_OPLOG, { keyPath: 'id' });
          oplogStore.createIndex('synced', 'synced', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  private async getDB(): Promise<IDBDatabase> {
    await this.initPromise;
    return this.db!;
  }

  async getDoc(collection: string, id: string): Promise<Doc | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, 'readonly');
      const store = tx.objectStore(STORE_DOCS);
      const request = store.get(`${collection}:${id}`);
      request.onsuccess = () => {
        const entry = request.result as IDBDocEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        const { _key: _k, _collection: _c, ...doc } = entry;
        resolve(doc as Doc);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllDocs(collection: string): Promise<Doc[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, 'readonly');
      const store = tx.objectStore(STORE_DOCS);
      const index = store.index('collection');
      const request = index.getAll(collection);
      request.onsuccess = () => {
        const entries = (request.result ?? []) as IDBDocEntry[];
        const docs = entries.map(({ _key: _k, _collection: _c, ...doc }) => doc as Doc);
        resolve(docs);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async putDoc(collection: string, doc: Doc): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DOCS, 'readwrite');
      const store = tx.objectStore(STORE_DOCS);
      const entry: IDBDocEntry = {
        ...doc,
        _key: `${collection}:${doc.id}`,
        _collection: collection,
      };
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteDoc(collection: string, id: string, version: HLC): Promise<void> {
    const existing = await this.getDoc(collection, id);
    if (!existing) return;
    await this.putDoc(collection, {
      ...existing,
      _deleted: true,
      _version: version,
      _updatedAt: version.ts,
    });
  }

  async appendOps(ops: Operation[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPLOG, 'readwrite');
      const store = tx.objectStore(STORE_OPLOG);
      for (const op of ops) {
        const entry: IDBOpEntry = { ...op, synced: false };
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getOpsSince(since: string): Promise<Operation[]> {
    const db = await this.getDB();
    const allOps: IDBOpEntry[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPLOG, 'readonly');
      const store = tx.objectStore(STORE_OPLOG);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result ?? []) as IDBOpEntry[]);
      request.onerror = () => reject(request.error);
    });

    if (!since) {
      return allOps.map(({ synced: _s, ...op }) => op as Operation);
    }

    const sinceHlc = deserializeHLC(since);
    return allOps
      .filter((op) => compareHLC(op.hlc, sinceHlc) > 0)
      .map(({ synced: _s, ...op }) => op as Operation);
  }

  async getUnsyncedOps(): Promise<Operation[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPLOG, 'readonly');
      const store = tx.objectStore(STORE_OPLOG);
      const index = store.index('synced');
      const request = index.getAll(IDBKeyRange.only(false));
      request.onsuccess = () => {
        const entries = (request.result ?? []) as IDBOpEntry[];
        const ops = entries.map(({ synced: _s, ...op }) => op as Operation);
        resolve(ops);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async markSynced(opIds: string[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OPLOG, 'readwrite');
      const store = tx.objectStore(STORE_OPLOG);
      for (const id of opIds) {
        const req = store.get(id);
        req.onsuccess = () => {
          const entry = req.result as IDBOpEntry | undefined;
          if (entry) {
            store.put({ ...entry, synced: true });
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS, STORE_OPLOG], 'readwrite');
      tx.objectStore(STORE_DOCS).clear();
      tx.objectStore(STORE_OPLOG).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
