import type { SyncConfig, SyncStatus, SyncStatusListener, Operation } from '../types.js';
import { encodeSyncMessage, decodeSyncMessage, createPullMessage, createPushMessage } from './protocol.js';

export interface SyncClientCallbacks {
  onRemoteOps: (ops: Operation[]) => Promise<void>;
  getUnsyncedOps: () => Promise<Operation[]>;
  getLastSyncHLC: () => string | undefined;
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private status: SyncStatus = 'disconnected';
  private statusListeners = new Set<SyncStatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    private config: SyncConfig,
    private clientId: string,
    private callbacks: SyncClientCallbacks,
  ) {}

  connect(): void {
    if (this.ws !== null) return;
    this.setStatus('connecting');

    const url = this.config.token
      ? `${this.config.url}?token=${encodeURIComponent(this.config.token)}`
      : this.config.url;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data as string);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => this.handleError();
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.reconnectAttempt = 0;
    this.setStatus('disconnected');
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  onStatusChange(listener: SyncStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  pushOps(ops: Operation[]): void {
    if (this.ws?.readyState === WebSocket.OPEN && ops.length > 0) {
      const msg = createPushMessage(this.clientId, ops);
      this.ws.send(encodeSyncMessage(msg));
    }
  }

  private handleOpen(): void {
    this.reconnectAttempt = 0;
    this.setStatus('connected');

    // Send pull to get any missed ops
    const since = this.callbacks.getLastSyncHLC();
    const pullMsg = createPullMessage(this.clientId, since);
    this.ws!.send(encodeSyncMessage(pullMsg));

    // Push any locally unsynced ops
    this.callbacks.getUnsyncedOps().then((ops) => {
      if (ops.length > 0) {
        this.pushOps(ops);
      }
    }).catch(() => {
      // ignore errors fetching unsynced ops
    });
  }

  private handleMessage(data: string): void {
    let msg;
    try {
      msg = decodeSyncMessage(data);
    } catch {
      return;
    }

    if (msg.type === 'ops' && Array.isArray(msg.ops) && msg.ops.length > 0) {
      this.setStatus('syncing');
      this.callbacks.onRemoteOps(msg.ops).then(() => {
        this.setStatus('connected');
      }).catch(() => {
        this.setStatus('error');
      });
    } else if (msg.type === 'ack') {
      // Server acknowledged our push — nothing to do at this layer
    } else if (msg.type === 'error') {
      this.setStatus('error');
    }
  }

  private handleClose(): void {
    this.ws = null;
    this.setStatus('disconnected');
    if (this.config.autoReconnect !== false) {
      this.scheduleReconnect();
    }
  }

  private handleError(): void {
    this.ws?.close();
    this.setStatus('error');
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private scheduleReconnect(): void {
    const baseDelay = this.config.reconnectDelay ?? 1000;
    const maxDelay = this.config.maxReconnectDelay ?? 30000;
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt) + jitter, maxDelay);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
