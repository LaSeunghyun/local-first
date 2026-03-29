import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import type { Doc, QueryFilter, SyncStatus, SyncConfig } from '@local-first/store';
import { SyncClient } from '@local-first/store';
import { useStore } from './context.js';

// ---------------------------------------------------------------------------
// useDoc
// ---------------------------------------------------------------------------

export function useDoc<T extends Record<string, unknown>>(
  collectionName: string,
  id: string,
): Doc<T> | null {
  const store = useStore();
  const snapshotRef = useRef<Doc<T> | null>(null);
  const notifyRef = useRef<Set<() => void>>(new Set());

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      notifyRef.current.add(onStoreChange);

      const col = store.collection<T>(collectionName);
      const unsubscribe = col.subscribeDoc(id, (doc) => {
        snapshotRef.current = doc;
        for (const listener of notifyRef.current) {
          listener();
        }
      });

      return () => {
        notifyRef.current.delete(onStoreChange);
        unsubscribe();
      };
    },
    [store, collectionName, id],
  );

  const getSnapshot = useCallback((): Doc<T> | null => {
    return snapshotRef.current;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// useQuery
// ---------------------------------------------------------------------------

export function useQuery<T extends Record<string, unknown>>(
  collectionName: string,
  filter?: QueryFilter<T>,
): Doc<T>[] {
  const store = useStore();
  const snapshotRef = useRef<Doc<T>[]>([]);
  const notifyRef = useRef<Set<() => void>>(new Set());

  // Serialize filter for stable dependency comparison
  const filterKey = filter !== undefined ? JSON.stringify(filter) : '';

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      notifyRef.current.add(onStoreChange);

      const col = store.collection<T>(collectionName);
      const parsedFilter: QueryFilter<T> = filterKey
        ? (JSON.parse(filterKey) as QueryFilter<T>)
        : {};

      const unsubscribe = col.subscribeQuery(parsedFilter, (docs) => {
        snapshotRef.current = docs;
        for (const listener of notifyRef.current) {
          listener();
        }
      });

      return () => {
        notifyRef.current.delete(onStoreChange);
        unsubscribe();
      };
    },
    [store, collectionName, filterKey],
  );

  const getSnapshot = useCallback((): Doc<T>[] => {
    return snapshotRef.current;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// useMutation
// ---------------------------------------------------------------------------

export interface MutationFunctions<T extends Record<string, unknown>> {
  put: (data: T & { id: string }) => Promise<Doc<T>>;
  update: (id: string, fields: Partial<T>) => Promise<Doc<T> | null>;
  del: (id: string) => Promise<void>;
}

export function useMutation<T extends Record<string, unknown>>(
  collectionName: string,
): MutationFunctions<T> {
  const store = useStore();

  const put = useCallback(
    (data: T & { id: string }): Promise<Doc<T>> => {
      return store.collection<T>(collectionName).put(data);
    },
    [store, collectionName],
  );

  const update = useCallback(
    (id: string, fields: Partial<T>): Promise<Doc<T> | null> => {
      return store.collection<T>(collectionName).update(id, fields);
    },
    [store, collectionName],
  );

  const del = useCallback(
    (id: string): Promise<void> => {
      return store.collection<T>(collectionName).delete(id);
    },
    [store, collectionName],
  );

  return { put, update, del };
}

// ---------------------------------------------------------------------------
// useSync
// ---------------------------------------------------------------------------

export interface SyncControls {
  status: SyncStatus;
  connect: (urlOrConfig: string | SyncConfig) => void;
  disconnect: () => void;
}

export function useSync(): SyncControls {
  const store = useStore();
  const [status, setStatus] = useState<SyncStatus>('disconnected');
  const clientRef = useRef<SyncClient | null>(null);
  const unsubStatusRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unsubStatusRef.current?.();
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  const connect = useCallback(
    (urlOrConfig: string | SyncConfig): void => {
      // Tear down existing client
      unsubStatusRef.current?.();
      clientRef.current?.disconnect();
      clientRef.current = null;

      const config: SyncConfig =
        typeof urlOrConfig === 'string' ? { url: urlOrConfig } : urlOrConfig;

      const client = new SyncClient(config, store.clientId, {
        onRemoteOps: (ops) => store._applyRemoteOps(ops),
        getUnsyncedOps: () => store._getUnsyncedOps(),
        getLastSyncHLC: () => undefined,
      });

      clientRef.current = client;
      unsubStatusRef.current = client.onStatusChange((s) => setStatus(s));

      client.connect();
      setStatus(client.getStatus());
    },
    [store],
  );

  const disconnect = useCallback((): void => {
    unsubStatusRef.current?.();
    unsubStatusRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus('disconnected');
  }, []);

  return { status, connect, disconnect };
}
