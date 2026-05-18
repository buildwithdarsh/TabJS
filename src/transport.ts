import type { Envelope } from './types.js';
import {
  hasBroadcastChannel,
  hasStorage,
  safeJsonParse,
  safeJsonStringify,
} from './utils.js';

export type TransportListener = (env: Envelope) => void;

/**
 * Wire-level transport that fans messages out via BroadcastChannel and/or
 * localStorage events. Each envelope carries a random id so duplicates from
 * the dual-write path can be deduplicated on receive.
 */
export class Transport {
  private readonly win: Window;
  private readonly storageKey: string;
  private readonly channelName: string;
  private readonly listeners = new Set<TransportListener>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxSeen = 256;

  private channel: BroadcastChannel | null = null;
  private readonly useChannel: boolean;
  private readonly useStorage: boolean;

  private readonly onStorage: (e: StorageEvent) => void;
  private readonly onChannelMessage: (e: MessageEvent) => void;
  private destroyed = false;

  constructor(
    win: Window,
    namespace: string,
    options: { broadcastChannelOnly?: boolean; storageOnly?: boolean } = {},
  ) {
    this.win = win;
    this.storageKey = `__${namespace}__msg__`;
    this.channelName = `${namespace}_channel`;

    const canChannel = hasBroadcastChannel(win) && !options.storageOnly;
    const canStorage = hasStorage(win) && !options.broadcastChannelOnly;
    this.useChannel = canChannel;
    this.useStorage = canStorage;

    this.onChannelMessage = (e: MessageEvent) => {
      const env = e.data as Envelope | undefined;
      if (!env || typeof env !== 'object' || !env._id) return;
      this.receive(env);
    };

    this.onStorage = (e: StorageEvent) => {
      if (e.key !== this.storageKey || !e.newValue) return;
      const env = safeJsonParse<Envelope>(e.newValue);
      if (!env || !env._id) return;
      this.receive(env);
    };

    if (this.useChannel) {
      this.channel = new (win as unknown as { BroadcastChannel: typeof BroadcastChannel })
        .BroadcastChannel(this.channelName);
      this.channel.addEventListener('message', this.onChannelMessage);
    }
    if (this.useStorage) {
      this.win.addEventListener('storage', this.onStorage);
    }
  }

  /** Subscribe to incoming envelopes. Returns an unsubscribe function. */
  subscribe(fn: TransportListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Send an envelope to all other tabs. */
  send(env: Envelope): void {
    if (this.destroyed) return;
    // Record locally so we don't process our own echo from storage.
    this.markSeen(env._id);

    if (this.useChannel && this.channel) {
      try {
        this.channel.postMessage(env);
      } catch {
        // Some payloads aren't structured-clonable — fall through to storage.
      }
    }
    if (this.useStorage) {
      try {
        const key = this.storageKey;
        const value = safeJsonStringify(env);
        this.win.localStorage.setItem(key, value);
        // Immediately remove so a future identical value still fires a storage event.
        this.win.localStorage.removeItem(key);
      } catch {
        /* quota or disabled storage — best effort */
      }
    }
  }

  /** Whether the transport is wired up to anything that can deliver messages. */
  get isLive(): boolean {
    return !this.destroyed && (this.useChannel || this.useStorage);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.channel) {
      this.channel.removeEventListener('message', this.onChannelMessage);
      this.channel.close();
      this.channel = null;
    }
    if (this.useStorage) {
      this.win.removeEventListener('storage', this.onStorage);
    }
    this.listeners.clear();
  }

  private markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.maxSeen) {
      const drop = this.seenOrder.shift();
      if (drop) this.seen.delete(drop);
    }
  }

  private receive(env: Envelope): void {
    if (this.seen.has(env._id)) return;
    this.markSeen(env._id);
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(env);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[tab.js] transport listener threw:', err);
      }
    }
  }
}
