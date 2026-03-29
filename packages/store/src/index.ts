export type {
  HLC,
  Doc,
  DocMeta,
  OpType,
  Operation,
  SyncMessageType,
  SyncMessage,
  StorageAdapter,
  QueryFilter,
  QueryOptions,
  Unsubscribe,
  DocSubscriber,
  CollectionSubscriber,
  CollectionDef,
  StoreConfig,
  SyncConfig,
  SyncStatus,
  SyncStatusListener,
} from './types.js';

export { createStore, Store } from './store.js';
export { Collection } from './collection.js';
export { MemoryAdapter } from './persistence/memory.js';
export { IndexedDBAdapter } from './persistence/indexeddb.js';
export { SyncClient } from './sync/client.js';
export type { SyncClientCallbacks } from './sync/client.js';
export {
  createHLC,
  increment,
  receive,
  compareHLC,
  serializeHLC,
  deserializeHLC,
  generateNodeId,
} from './hlc/clock.js';
export { applyOperation, mergeDoc } from './crdt/lww.js';
