# local-first

**Offline-first data engine with automatic sync**

[![npm](https://img.shields.io/npm/v/@local-first/store?color=blue)](https://www.npmjs.com/package/@local-first/store)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-passing-brightgreen)](#)
[![bundle size](https://img.shields.io/badge/core-~20KB-blue)](#)

Build apps that work offline and sync automatically — zero conflict resolution code needed.

---

## Why?

- **Apps die when the server is down.** Users lose work, get errors, and churn. Local-first apps keep working regardless of connectivity.
- **Conflict resolution is hard.** Writing correct merge logic for concurrent edits across devices is notoriously error-prone. local-first handles it automatically with LWW CRDT.
- **Real-time sync is complex.** WebSocket reconnection, operation ordering, deduplication, and clock skew are solved problems here — not yours to re-implement.

---

## Quick Start

```bash
npm install @local-first/store
```

```ts
import { createStore } from '@local-first/store';
import { IndexedDBAdapter } from '@local-first/store';

// 1. Create a store (persists to IndexedDB automatically)
const store = createStore({
  name: 'my-app',
  collections: { todos: {} },
  storage: new IndexedDBAdapter('my-app'),
});

// 2. CRUD — works offline, no await needed for reads
const todos = store.collection('todos');
await todos.put({ id: 'todo-1', text: 'Buy groceries', done: false });
await todos.update('todo-1', { done: true });
const all = await todos.find();

// 3. Sync — one line, auto-reconnects on disconnect
store.sync('ws://localhost:3000');
```

---

## Features

| Feature | Description |
|---|---|
| **Offline-first** | IndexedDB persistence. Reads and writes work with no network. |
| **Automatic sync** | WebSocket-based real-time sync with exponential backoff reconnect. |
| **CRDT conflict resolution** | Last-Writer-Wins (LWW) per field — no manual merge code, ever. |
| **HLC ordering** | Hybrid Logical Clock gives distributed total ordering without a central clock. |
| **React hooks** | `useDoc`, `useQuery`, `useMutation` built on `useSyncExternalStore`. |
| **Tiny footprint** | ~20KB core, zero runtime dependencies. |
| **Type-safe** | Full TypeScript with generic document types throughout. |
| **Secure** | Token auth, rate limiting, prototype pollution protection, HLC drift guard. |

---

## React Example

```tsx
import { createStore, IndexedDBAdapter } from '@local-first/store';
import { StoreProvider, useQuery, useMutation } from '@local-first/react';

const store = createStore({
  name: 'todos',
  collections: { todos: {} },
  storage: new IndexedDBAdapter('todos'),
});
store.sync('ws://localhost:3000');

interface Todo { text: string; done: boolean; }

function TodoApp() {
  const todos = useQuery<Todo>('todos');
  const { put, update, del } = useMutation<Todo>('todos');

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>
          <input
            type="checkbox"
            checked={todo.data.done}
            onChange={() => update(todo.id, { done: !todo.data.done })}
          />
          {todo.data.text}
          <button onClick={() => del(todo.id)}>x</button>
        </li>
      ))}
      <button onClick={() => put({ id: crypto.randomUUID(), text: 'New todo', done: false })}>
        Add
      </button>
    </ul>
  );
}

export default function App() {
  return <StoreProvider store={store}><TodoApp /></StoreProvider>;
}
```

---

## API Reference

### Store

```ts
import { createStore } from '@local-first/store';

const store = createStore({
  name: string,           // namespace for persistence
  collections: { [name]: {} },
  storage?: StorageAdapter, // default: MemoryAdapter
  clientId?: string,        // default: auto-generated UUID
});

store.collection<T>(name)  // → Collection<T>
store.sync(url | SyncConfig)
store.disconnect()
```

### Collection

```ts
const col = store.collection<Todo>('todos');

// Writes (append to oplog, notify subscribers)
await col.put({ id, ...fields })          // → Doc<T>
await col.update(id, partialFields)       // → Doc<T> | null
await col.delete(id)                      // → void

// Reads
await col.get(id)                         // → Doc<T> | null
await col.find(filter?)                   // → Doc<T>[]
await col.findOne(filter?)                // → Doc<T> | null

// Subscriptions (reactive, calls listener immediately + on change)
col.subscribe(listener)                   // → Unsubscribe
col.subscribeDoc(id, listener)            // → Unsubscribe
col.subscribeQuery(filter, listener)      // → Unsubscribe
```

### Document shape

```ts
interface Doc<T> {
  id: string;
  data: T;           // your fields
  _version: HLC;     // last-write version (Hybrid Logical Clock)
  _deleted: boolean; // soft-delete tombstone
  _updatedAt: number; // wall-clock ms of last write
}
```

### React Hooks

```ts
import { useDoc, useQuery, useMutation, useSync } from '@local-first/react';

// Single document — re-renders on change
const doc = useDoc<Todo>('todos', id);

// Collection — re-renders when any matching doc changes
const todos = useQuery<Todo>('todos');
const doneTodos = useQuery<Todo>('todos', { done: true });

// Write operations
const { put, update, del } = useMutation<Todo>('todos');

// Sync status
const { status, connect, disconnect } = useSync();
// status: 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error'
```

### SyncConfig

```ts
store.sync({
  url: 'ws://localhost:3000',
  token: 'secret',          // passed as ?token= query param
  autoReconnect: true,      // default true
  reconnectDelay: 1000,     // base backoff ms, default 1000
  maxReconnectDelay: 30000, // cap for exponential backoff, default 30000
});
```

---

## Sync Server

### Run

```bash
# Quickstart — listens on ws://localhost:3000
npx @local-first/sync-server

# Custom port
npx @local-first/sync-server 8080
```

### Programmatic

```ts
import { SyncServer } from '@local-first/sync-server';

const server = new SyncServer({
  port: 3000,
  host: '0.0.0.0',
  token: process.env.SYNC_TOKEN,  // optional — clients pass ?token=
  maxMessagesPerSecond: 100,      // per-client rate limit
});

await server.start();
// ... handle SIGINT/SIGTERM
await server.stop();
```

### Deploy

The sync server is a plain Node.js process. Deploy it anywhere that runs Node:

```dockerfile
FROM node:20-alpine
RUN npm install -g @local-first/sync-server
EXPOSE 3000
CMD ["lf-server", "3000"]
```

For production, put it behind a reverse proxy (nginx, Caddy) with TLS to use `wss://`.

---

## Architecture

local-first uses three layered primitives to achieve conflict-free sync:

**Hybrid Logical Clock (HLC)** assigns every operation a `{ ts, counter, node }` triple. This gives a total ordering across all clients without a central authority, while staying close to wall-clock time.

**Operation Log (Oplog)** every mutation (`put`, `update`, `delete`) is recorded as an immutable `Operation` before being applied locally. Operations are pushed to the sync server and replayed on other clients.

**LWW CRDT** when two operations touch the same field concurrently, the one with the higher HLC wins. No merge functions, no manual conflict UI required for most use cases.

```
 Client A                      Sync Server                  Client B
---------                      -----------                  --------
  write                              |                          |
    |-- create Op (HLC tick) ------> |                          |
    |-- apply locally               |                          |
    |-- push to server -----------> |                          |
                                    |-- broadcast to peers --> |
                                    |                          |-- receive Op
                                    |                          |-- LWW merge
                                    |                          |-- notify subscribers
  pull on reconnect                 |                          |
    |<--- ops since lastHLC --------|                          |
    |-- LWW merge + notify          |                          |
```

Clients that go offline accumulate unsynced ops locally (IndexedDB). On reconnect they push their oplog and pull any ops they missed — the server deduplicates by op ID, so replaying ops is always safe.

---

## Roadmap

- [ ] Field-level CRDT beyond LWW (counters, sets, sequences)
- [ ] Presence and cursor awareness (who is online, what they are editing)
- [ ] Conflict UI helper — expose concurrent edits to the application layer for user-visible resolution
- [ ] SQLite adapter for Node.js / Electron / React Native
- [ ] React Native support

---

## Contributing

Issues and PRs are welcome. Please open an issue before large changes to discuss the approach.

```bash
git clone https://github.com/your-org/local-first
cd local-first
npm install
npm run build
npm test
```

The repo is a Turborepo monorepo. Each package under `packages/` has its own `build`, `typecheck`, and `test` scripts.

---

## License

MIT
