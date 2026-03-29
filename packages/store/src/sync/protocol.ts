import type { SyncMessage, Operation } from '../types.js';

export function encodeSyncMessage(msg: SyncMessage): string {
  return JSON.stringify(msg);
}

export function decodeSyncMessage(data: string): SyncMessage {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid sync message: not an object');
  }
  const msg = parsed as Record<string, unknown>;
  if (typeof msg['type'] !== 'string') {
    throw new Error('Invalid sync message: missing type');
  }
  if (typeof msg['clientId'] !== 'string') {
    throw new Error('Invalid sync message: missing clientId');
  }
  return parsed as SyncMessage;
}

export function createPullMessage(clientId: string, since?: string): SyncMessage {
  return {
    type: 'pull',
    clientId,
    since,
  };
}

export function createPushMessage(clientId: string, ops: Operation[]): SyncMessage {
  return {
    type: 'push',
    clientId,
    ops,
  };
}

export function createAckMessage(clientId: string, ackId: string): SyncMessage {
  return {
    type: 'ack',
    clientId,
    ackId,
  };
}
