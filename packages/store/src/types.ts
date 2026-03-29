/**
 * Core type definitions for the Local-First Sync Engine.
 */

// ---------------------------------------------------------------------------
// Hybrid Logical Clock
// ---------------------------------------------------------------------------

export interface HLC {
  /** Wall-clock timestamp in ms */
  ts: number;
  /** Logical counter for same-timestamp ordering */
  counter: number;
  /** Unique node identifier */
  node: string;
}

// ---------------------------------------------------------------------------
// Document Model
// ---------------------------------------------------------------------------

export interface Doc<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  _version: HLC;
  _deleted: boolean;
  _updatedAt: number;
  data: T;
}

export interface DocMeta {
  id: string;
  _version: HLC;
  _deleted: boolean;
  _updatedAt: number;
}

// ---------------------------------------------------------------------------
// Operations (Change Log)
// ---------------------------------------------------------------------------

export type OpType = 'put' | 'update' | 'delete';

export interface Operation {
  id: string;
  type: OpType;
  collection: string;
  docId: string;
  fields?: Record<string, unknown>;
  hlc: HLC;
  clientId: string;
}

// ---------------------------------------------------------------------------
// Sync Protocol Messages
// ---------------------------------------------------------------------------

export type SyncMessageType = 'pull' | 'push' | 'ops' | 'ack' | 'snapshot' | 'error';

export interface SyncMessage {
  type: SyncMessageType;
  ops?: Operation[];
  since?: string;
  clientId: string;
  ackId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Storage Adapter
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /** Get a document by collection and ID */
  getDoc(collection: string, id: string): Promise<Doc | null>;
  /** Get all documents in a collection */
  getAllDocs(collection: string): Promise<Doc[]>;
  /** Write a document (upsert) */
  putDoc(collection: string, doc: Doc): Promise<void>;
  /** Delete a document (tombstone) */
  deleteDoc(collection: string, id: string, version: HLC): Promise<void>;
  /** Append operations to the log */
  appendOps(ops: Operation[]): Promise<void>;
  /** Get operations since a given HLC (serialized) */
  getOpsSince(since: string): Promise<Operation[]>;
  /** Get all unsynced operations (not yet acknowledged) */
  getUnsyncedOps(): Promise<Operation[]>;
  /** Mark operations as synced */
  markSynced(opIds: string[]): Promise<void>;
  /** Clear all data */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export type QueryFilter<T> = Partial<T>;

export interface QueryOptions {
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

export type DocSubscriber<T extends Record<string, unknown> = Record<string, unknown>> = (doc: Doc<T> | null) => void;
export type CollectionSubscriber<T extends Record<string, unknown> = Record<string, unknown>> = (docs: Doc<T>[]) => void;

// ---------------------------------------------------------------------------
// Store Config
// ---------------------------------------------------------------------------

export interface CollectionDef {
  /** Optional — not enforced at runtime in MVP */
  schema?: Record<string, unknown>;
}

export interface StoreConfig {
  /** Store name (used for persistence namespace) */
  name: string;
  /** Collection definitions */
  collections: Record<string, CollectionDef>;
  /** Custom storage adapter (defaults to MemoryAdapter) */
  storage?: StorageAdapter;
  /** Unique client ID (auto-generated if omitted) */
  clientId?: string;
}

// ---------------------------------------------------------------------------
// Sync Config
// ---------------------------------------------------------------------------

export interface SyncConfig {
  /** WebSocket URL: ws://host:port */
  url: string;
  /** Auth token (optional) */
  token?: string;
  /** Auto-reconnect (default true) */
  autoReconnect?: boolean;
  /** Reconnect base delay ms (default 1000) */
  reconnectDelay?: number;
  /** Max reconnect delay ms (default 30000) */
  maxReconnectDelay?: number;
}

export type SyncStatus = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

export type SyncStatusListener = (status: SyncStatus) => void;
