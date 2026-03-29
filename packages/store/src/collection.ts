import type {
  Doc,
  StorageAdapter,
  QueryFilter,
  Unsubscribe,
  DocSubscriber,
  CollectionSubscriber,
  Operation,
  OpType,
} from './types.js';
import { applyOperation } from './crdt/lww.js';

type CreateOpFn = (
  type: OpType,
  docId: string,
  fields?: Record<string, unknown>,
) => Operation;

interface DocSub<T extends Record<string, unknown>> {
  id: string;
  listener: DocSubscriber<T>;
}

interface CollectionSub<T extends Record<string, unknown>> {
  filter?: QueryFilter<T>;
  listener: CollectionSubscriber<T>;
}

export class Collection<T extends Record<string, unknown>> {
  private docSubs = new Set<DocSub<T>>();
  private collectionSubs = new Set<CollectionSub<T>>();

  constructor(
    readonly name: string,
    private storage: StorageAdapter,
    private createOp: CreateOpFn,
    private onOpsCreated?: (ops: Operation[]) => void,
  ) {}

  async get(id: string): Promise<Doc<T> | null> {
    const doc = await this.storage.getDoc(this.name, id);
    if (!doc || doc._deleted) return null;
    return doc as Doc<T>;
  }

  async put(data: T & { id: string }): Promise<Doc<T>> {
    const { id, ...fields } = data;
    const op = this.createOp('put', id, fields as Record<string, unknown>);
    const existing = await this.storage.getDoc(this.name, id);
    const updated = applyOperation<T>(existing as Doc<T> | null, op);
    await this.storage.putDoc(this.name, updated as Doc);
    await this.storage.appendOps([op]);
    this.onOpsCreated?.([op]);
    await this._notify();
    return updated;
  }

  async update(id: string, fields: Partial<T>): Promise<Doc<T> | null> {
    const existing = await this.storage.getDoc(this.name, id);
    if (!existing || existing._deleted) return null;
    const op = this.createOp('update', id, fields as Record<string, unknown>);
    const updated = applyOperation<T>(existing as Doc<T>, op);
    await this.storage.putDoc(this.name, updated as Doc);
    await this.storage.appendOps([op]);
    this.onOpsCreated?.([op]);
    await this._notify();
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.storage.getDoc(this.name, id);
    if (!existing || existing._deleted) return;
    const op = this.createOp('delete', id);
    const updated = applyOperation<T>(existing as Doc<T>, op);
    await this.storage.putDoc(this.name, updated as Doc);
    await this.storage.appendOps([op]);
    this.onOpsCreated?.([op]);
    await this._notify();
  }

  async find(filter?: QueryFilter<T>): Promise<Doc<T>[]> {
    const all = await this.storage.getAllDocs(this.name);
    const active = all.filter((d) => !d._deleted) as Doc<T>[];
    if (!filter || Object.keys(filter).length === 0) return active;
    return active.filter((doc) => matchesFilter(doc, filter));
  }

  async findOne(filter?: QueryFilter<T>): Promise<Doc<T> | null> {
    const results = await this.find(filter);
    return results[0] ?? null;
  }

  subscribe(listener: CollectionSubscriber<T>): Unsubscribe {
    const sub: CollectionSub<T> = { listener };
    this.collectionSubs.add(sub);
    // Emit current state immediately
    this.find().then((docs) => listener(docs));
    return () => this.collectionSubs.delete(sub);
  }

  subscribeDoc(id: string, listener: DocSubscriber<T>): Unsubscribe {
    const sub: DocSub<T> = { id, listener };
    this.docSubs.add(sub);
    // Emit current state immediately
    this.get(id).then((doc) => listener(doc));
    return () => this.docSubs.delete(sub);
  }

  subscribeQuery(filter: QueryFilter<T>, listener: CollectionSubscriber<T>): Unsubscribe {
    const sub: CollectionSub<T> = { filter, listener };
    this.collectionSubs.add(sub);
    // Emit current state immediately
    this.find(filter).then((docs) => listener(docs));
    return () => this.collectionSubs.delete(sub);
  }

  async _applyRemoteOp(op: Operation): Promise<void> {
    const existing = await this.storage.getDoc(this.name, op.docId);
    const updated = applyOperation<T>(existing as Doc<T> | null, op);
    await this.storage.putDoc(this.name, updated as Doc);
    await this._notify();
  }

  async _notify(): Promise<void> {
    // Notify doc subscribers
    for (const sub of this.docSubs) {
      try {
        const doc = await this.get(sub.id);
        sub.listener(doc);
      } catch {
        // ignore failing subscribers
      }
    }
    // Notify collection subscribers (with optional filter)
    for (const sub of this.collectionSubs) {
      try {
        const docs = await this.find(sub.filter);
        sub.listener(docs);
      } catch {
        // ignore failing subscribers
      }
    }
  }
}

function matchesFilter<T extends Record<string, unknown>>(
  doc: Doc<T>,
  filter: QueryFilter<T>,
): boolean {
  for (const key of Object.keys(filter) as (keyof T)[]) {
    if (doc.data[key] !== filter[key]) return false;
  }
  return true;
}
