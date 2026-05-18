import { Transport } from './transport.js';
import type {
  Envelope,
  LineageId,
  Listener,
  LockOptions,
  MessageHandler,
  RequestOptions,
  TabEvent,
  TabId,
  TabInfo,
  TabMetrics,
  TabManagerOptions,
  Unsubscribe,
} from './types.js';
import { hasStorage, makeId, now, resolveWindow, safeJsonParse, safeJsonStringify } from './utils.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface LockRecord {
  owner: TabId;
  token: string;
  acquiredAt: number;
  /** Updated by the owner each heartbeat — used to detect abandoned locks. */
  heartbeat: number;
}

const KIND_HEARTBEAT = 'heartbeat';
const KIND_BYE = 'bye';
const KIND_MSG = 'msg';
const KIND_REQ = 'req';
const KIND_RES = 'res';
const KIND_STATE_SET = 'state-set';
const KIND_STATE_GET = 'state-get';
const KIND_STATE_REPLY = 'state-reply';
const KIND_LOCK_RELEASE = 'lock-release';

export class TabManager<TState = unknown, TPayload = unknown> {
  /** Stable id for this tab, generated at construction. */
  readonly id: TabId;
  /** Wall-clock time the tab was opened. */
  readonly bornAt: number;
  /** Lineage id from sessionStorage — shared with duplicated tabs. */
  readonly lineage: LineageId;

  readonly metrics: TabMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    broadcasts: 0,
    requests: 0,
    responses: 0,
    stateUpdates: 0,
    locksAcquired: 0,
  };

  private readonly win: Window;
  private readonly namespace: string;
  private readonly heartbeatInterval: number;
  private readonly tabTimeout: number;
  private readonly transport: Transport;
  private readonly listeners = new Set<Listener<TState, TPayload>>();
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly registry = new Map<TabId, TabInfo>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly heldLocks = new Map<string, { token: string; release: () => void }>();
  private readonly stateKey: string;
  private readonly lockKeyPrefix: string;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private leaderId: TabId | null = null;
  private destroyed = false;
  private meta: Record<string, unknown>;
  private focused: boolean;
  private state: TState | null;

  private readonly onVisibility: () => void;
  private readonly onFocus: () => void;
  private readonly onBlur: () => void;
  private readonly onBeforeUnload: () => void;

  constructor(options: TabManagerOptions<TState> = {}) {
    this.win = resolveWindow(options.window);
    this.namespace = options.namespace ?? 'tabjs';
    this.heartbeatInterval = options.heartbeatInterval ?? 1500;
    this.tabTimeout = options.tabTimeout ?? 5000;
    this.meta = options.meta ? { ...options.meta } : {};
    this.id = makeId('tab');
    this.bornAt = now();
    this.lineage = this.resolveLineage();
    this.stateKey = `__${this.namespace}__state__`;
    this.lockKeyPrefix = `__${this.namespace}__lock__`;

    const visible = this.win.document?.visibilityState;
    this.focused =
      (visible == null || visible === 'visible') && this.win.document?.hasFocus?.() !== false;

    this.transport = new Transport(this.win, this.namespace, {
      broadcastChannelOnly: options.broadcastChannelOnly,
      storageOnly: options.storageOnly,
    });
    this.transport.subscribe((env) => this.handleEnvelope(env));

    this.state = this.readStoredState() ?? (options.initialState ?? null);

    // Register self in the local registry so callers can see this tab immediately.
    this.registry.set(this.id, this.snapshotSelf());
    this.leaderId = this.id;

    this.onVisibility = () => this.updatePresence();
    this.onFocus = () => this.updatePresence();
    this.onBlur = () => this.updatePresence();
    this.onBeforeUnload = () => this.sayBye();

    this.win.document?.addEventListener?.('visibilitychange', this.onVisibility);
    this.win.addEventListener?.('focus', this.onFocus);
    this.win.addEventListener?.('blur', this.onBlur);
    this.win.addEventListener?.('beforeunload', this.onBeforeUnload);
    this.win.addEventListener?.('pagehide', this.onBeforeUnload);

    // Announce ourselves immediately and start the heartbeat.
    this.beat();
    this.heartbeatTimer = this.win.setInterval(() => this.beat(), this.heartbeatInterval);
    this.sweepTimer = this.win.setInterval(() => this.sweep(), this.heartbeatInterval);

    // Ask any existing tab for the current shared state.
    this.broadcastEnvelope(KIND_STATE_GET, '', null, null);
  }

  // -----------------------------------------------------------------------
  // Read-only accessors
  // -----------------------------------------------------------------------

  /** This tab's current info snapshot. */
  get info(): TabInfo {
    return this.snapshotSelf();
  }

  /** Snapshot list of all known live tabs (including this one). */
  get tabs(): TabInfo[] {
    return Array.from(this.registry.values());
  }

  /** True if this tab is currently the elected leader. */
  get isLeader(): boolean {
    return this.leaderId === this.id;
  }

  /** Current leader tab info, or null if none is known. */
  get leader(): TabInfo | null {
    return this.leaderId ? this.registry.get(this.leaderId) ?? null : null;
  }

  /** Current shared state — synchronized across tabs. */
  getState(): TState | null {
    return this.state;
  }

  /**
   * True if this tab shares a sessionStorage lineage with another live tab —
   * i.e. it was likely duplicated via "Duplicate tab".
   */
  get isDuplicate(): boolean {
    for (const tab of this.registry.values()) {
      if (tab.id !== this.id && tab.lineage === this.lineage) return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Subscribe
  // -----------------------------------------------------------------------

  /** Subscribe to all tab events. */
  subscribe(listener: Listener<TState, TPayload>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to a single event type. */
  on<E extends TabEvent<TState, TPayload>['type']>(
    type: E,
    listener: (event: Extract<TabEvent<TState, TPayload>, { type: E }>) => void,
  ): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === type) listener(event as Extract<TabEvent<TState, TPayload>, { type: E }>);
    });
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /** Broadcast a message to every other tab. */
  broadcast<P = TPayload>(channel: string, payload?: P): void {
    this.broadcastEnvelope(KIND_MSG, channel, null, payload ?? null);
    this.metrics.broadcasts += 1;
  }

  /** Send a direct message to a specific tab. */
  send<P = TPayload>(targetId: TabId, channel: string, payload?: P): void {
    this.broadcastEnvelope(KIND_MSG, channel, targetId, payload ?? null);
  }

  /** Register a handler for an incoming message channel. Used by `request()`. */
  handle<P = unknown, R = unknown>(channel: string, handler: MessageHandler<P, R>): Unsubscribe {
    this.handlers.set(channel, handler as MessageHandler);
    return () => {
      if (this.handlers.get(channel) === (handler as MessageHandler)) {
        this.handlers.delete(channel);
      }
    };
  }

  /**
   * Send a request to a specific tab (or leader if `targetId` is null) and
   * await a response. Resolves with whatever the handler returned, or rejects
   * on timeout.
   */
  request<P = unknown, R = unknown>(
    targetId: TabId | null,
    channel: string,
    payload?: P,
    options: RequestOptions = {},
  ): Promise<R> {
    const target = targetId ?? this.leaderId ?? null;
    if (!target) return Promise.reject(new Error('[TabJS] no target tab for request'));
    const timeoutMs = options.timeout ?? 5000;

    return new Promise<R>((resolve, reject) => {
      const reqId = makeId('req');
      const timer = this.win.setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          reject(new Error(`[TabJS] request "${channel}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.broadcastEnvelope(KIND_REQ, channel, target, { reqId, payload: payload ?? null });
      this.metrics.requests += 1;
    });
  }

  // -----------------------------------------------------------------------
  // Shared state
  // -----------------------------------------------------------------------

  /** Replace shared state and broadcast the update to other tabs. */
  setState(updater: TState | ((prev: TState | null) => TState)): void {
    const next =
      typeof updater === 'function'
        ? (updater as (prev: TState | null) => TState)(this.state)
        : updater;
    const previous = this.state;
    this.state = next;
    this.writeStoredState(next);
    this.metrics.stateUpdates += 1;
    this.broadcastEnvelope(KIND_STATE_SET, '', null, next);
    this.emit({ type: 'state', state: next, previous, from: this.id });
  }

  /** Replace the metadata for this tab. Broadcast on the next heartbeat. */
  setMeta(meta: Record<string, unknown>): void {
    this.meta = { ...meta };
    this.beat();
  }

  // -----------------------------------------------------------------------
  // Singleton tab enforcement
  // -----------------------------------------------------------------------

  /**
   * Enforce a single live tab per origin. If another tab is already open when
   * this one starts, `onConflict` is called. Returns a teardown function.
   */
  singleton(onConflict: (others: TabInfo[]) => void): Unsubscribe {
    const check = () => {
      const others = this.tabs.filter((t) => t.id !== this.id);
      if (others.length > 0) onConflict(others);
    };
    // Delay one tick so heartbeats from existing tabs have a chance to arrive.
    const handle = this.win.setTimeout(check, this.heartbeatInterval * 2);
    const off = this.on('open', check);
    return () => {
      this.win.clearTimeout(handle);
      off();
    };
  }

  // -----------------------------------------------------------------------
  // Locks
  // -----------------------------------------------------------------------

  /**
   * Acquire a cross-tab lock for the duration of `fn`. Other tabs calling
   * `lock(key, ...)` for the same key will queue behind this one. The lock is
   * released automatically when `fn` settles (or after `staleAfter` ms if the
   * holder tab crashes).
   */
  async lock<T>(
    key: string,
    fn: () => T | Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const token = await this.acquireLock(key, options);
    try {
      this.metrics.locksAcquired += 1;
      return await fn();
    } finally {
      this.releaseLock(key, token);
    }
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;
    // Announce departure first — flipping `destroyed` here would short-circuit the bye in broadcastEnvelope.
    this.sayBye();
    this.destroyed = true;
    if (this.heartbeatTimer) this.win.clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) this.win.clearInterval(this.sweepTimer);
    this.win.document?.removeEventListener?.('visibilitychange', this.onVisibility);
    this.win.removeEventListener?.('focus', this.onFocus);
    this.win.removeEventListener?.('blur', this.onBlur);
    this.win.removeEventListener?.('beforeunload', this.onBeforeUnload);
    this.win.removeEventListener?.('pagehide', this.onBeforeUnload);
    for (const [, pending] of this.pending) {
      if (pending.timer) this.win.clearTimeout(pending.timer);
      pending.reject(new Error('[TabJS] TabManager destroyed before request resolved'));
    }
    this.pending.clear();
    for (const [key, held] of this.heldLocks) {
      this.releaseLock(key, held.token);
    }
    this.transport.destroy();
    this.listeners.clear();
    this.handlers.clear();
    this.registry.clear();
  }

  // -----------------------------------------------------------------------
  // Internals — registry / heartbeat
  // -----------------------------------------------------------------------

  private resolveLineage(): LineageId {
    const key = `__${this.namespace ?? 'tabjs'}__lineage__`;
    try {
      const existing = this.win.sessionStorage?.getItem(key);
      if (existing) return existing;
      const fresh = makeId('lin');
      this.win.sessionStorage?.setItem(key, fresh);
      return fresh;
    } catch {
      return makeId('lin');
    }
  }

  private snapshotSelf(): TabInfo {
    return {
      id: this.id,
      bornAt: this.bornAt,
      lastSeen: now(),
      focused: this.focused,
      meta: this.meta,
      url: this.win.location?.href ?? '',
      lineage: this.lineage,
    };
  }

  private beat(): void {
    if (this.destroyed) return;
    const info = this.snapshotSelf();
    this.registry.set(this.id, info);
    this.broadcastEnvelope(KIND_HEARTBEAT, '', null, info);
    this.electLeader();
    this.refreshHeldLocks();
  }

  private sweep(): void {
    if (this.destroyed) return;
    const cutoff = now() - this.tabTimeout;
    let changed = false;
    const duplicates: TabInfo[] = [];
    for (const [id, info] of Array.from(this.registry.entries())) {
      if (id === this.id) continue;
      if (info.lastSeen < cutoff) {
        this.registry.delete(id);
        changed = true;
        this.emit({ type: 'close', tab: info });
      } else if (info.lineage === this.lineage) {
        duplicates.push(info);
      }
    }
    if (changed) this.electLeader();
    if (duplicates.length > 0) {
      this.emit({ type: 'duplicate', originals: duplicates });
    }
  }

  private updatePresence(): void {
    const visible = this.win.document?.visibilityState;
    const nextFocused =
      (visible == null || visible === 'visible') && this.win.document?.hasFocus?.() !== false;
    if (nextFocused === this.focused) return;
    this.focused = nextFocused;
    const snap = this.snapshotSelf();
    this.registry.set(this.id, snap);
    this.broadcastEnvelope(KIND_HEARTBEAT, '', null, snap);
    this.emit({ type: nextFocused ? 'focus' : 'blur', tab: snap });
  }

  private sayBye(): void {
    try {
      this.broadcastEnvelope(KIND_BYE, '', null, { id: this.id });
    } catch {
      /* tab is closing — best effort */
    }
  }

  private electLeader(): void {
    let candidate: TabInfo | null = null;
    for (const info of this.registry.values()) {
      if (!candidate) {
        candidate = info;
        continue;
      }
      if (
        info.bornAt < candidate.bornAt ||
        (info.bornAt === candidate.bornAt && info.id < candidate.id)
      ) {
        candidate = info;
      }
    }
    const nextLeaderId = candidate?.id ?? null;
    if (nextLeaderId !== this.leaderId) {
      const previous = this.leaderId ? this.registry.get(this.leaderId) ?? null : null;
      this.leaderId = nextLeaderId;
      if (candidate) this.emit({ type: 'leader', leader: candidate, previous });
    }
  }

  // -----------------------------------------------------------------------
  // Internals — envelopes
  // -----------------------------------------------------------------------

  private broadcastEnvelope(kind: string, channel: string, to: TabId | null, payload: unknown): void {
    if (this.destroyed) return;
    const env: Envelope = {
      _id: makeId('e'),
      from: this.id,
      to,
      kind,
      channel,
      payload,
      ts: now(),
    };
    this.transport.send(env);
    this.metrics.messagesSent += 1;
  }

  private handleEnvelope(env: Envelope): void {
    if (env.from === this.id) return;
    if (env.to !== null && env.to !== this.id) return;
    this.metrics.messagesReceived += 1;

    switch (env.kind) {
      case KIND_HEARTBEAT:
        this.onHeartbeat(env.payload as TabInfo);
        break;
      case KIND_BYE:
        this.onBye((env.payload as { id: TabId }).id);
        break;
      case KIND_MSG:
        this.onMessage(env);
        break;
      case KIND_REQ:
        void this.onRequest(env);
        break;
      case KIND_RES:
        this.onResponse(env);
        break;
      case KIND_STATE_SET:
        this.onStateSet(env);
        break;
      case KIND_STATE_GET:
        this.onStateGet(env);
        break;
      case KIND_STATE_REPLY:
        this.onStateReply(env);
        break;
      case KIND_LOCK_RELEASE:
        // Lock-release acts as a wake-up — pollers will pick it up on next tick.
        break;
      default:
        // Unknown kinds are silently ignored — forward compatibility.
        break;
    }
  }

  private onHeartbeat(info: TabInfo): void {
    if (!info || typeof info.id !== 'string') return;
    const prev = this.registry.get(info.id);
    this.registry.set(info.id, info);
    if (!prev) {
      this.emit({ type: 'open', tab: info });
      if (info.lineage === this.lineage) {
        this.emit({ type: 'duplicate', originals: [info] });
      }
      this.electLeader();
    } else if (prev.focused !== info.focused) {
      this.emit({ type: info.focused ? 'focus' : 'blur', tab: info });
    }
  }

  private onBye(id: TabId): void {
    const info = this.registry.get(id);
    if (!info) return;
    this.registry.delete(id);
    this.emit({ type: 'close', tab: info });
    this.electLeader();
  }

  private onMessage(env: Envelope): void {
    this.emit({
      type: 'message',
      channel: env.channel,
      from: env.from,
      to: env.to,
      payload: env.payload as TPayload,
    });
  }

  private async onRequest(env: Envelope): Promise<void> {
    const handler = this.handlers.get(env.channel);
    const body = env.payload as { reqId: string; payload: unknown };
    if (!handler) {
      this.broadcastEnvelope(KIND_RES, env.channel, env.from, {
        reqId: body.reqId,
        error: `no handler for "${env.channel}"`,
      });
      return;
    }
    try {
      const result = await handler(body.payload, { from: env.from, channel: env.channel });
      this.broadcastEnvelope(KIND_RES, env.channel, env.from, {
        reqId: body.reqId,
        result,
      });
      this.metrics.responses += 1;
    } catch (err) {
      this.broadcastEnvelope(KIND_RES, env.channel, env.from, {
        reqId: body.reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onResponse(env: Envelope): void {
    const body = env.payload as { reqId: string; result?: unknown; error?: string };
    const pending = this.pending.get(body.reqId);
    if (!pending) return;
    this.pending.delete(body.reqId);
    if (pending.timer) this.win.clearTimeout(pending.timer);
    if (body.error) pending.reject(new Error(body.error));
    else pending.resolve(body.result);
  }

  private onStateSet(env: Envelope): void {
    const previous = this.state;
    this.state = env.payload as TState;
    this.writeStoredState(this.state);
    this.emit({ type: 'state', state: this.state, previous, from: env.from });
  }

  private onStateGet(env: Envelope): void {
    if (this.state == null) return;
    this.broadcastEnvelope(KIND_STATE_REPLY, '', env.from, this.state);
  }

  private onStateReply(env: Envelope): void {
    // Only adopt the reply if we still don't have local state — otherwise our
    // own setState beats a stale snapshot from another tab.
    if (this.state != null) return;
    const previous = this.state;
    this.state = env.payload as TState;
    this.writeStoredState(this.state);
    this.emit({ type: 'state', state: this.state, previous, from: env.from });
  }

  private emit(event: TabEvent<TState, TPayload>): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[TabJS] listener threw:', err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internals — shared state persistence
  // -----------------------------------------------------------------------

  private readStoredState(): TState | null {
    if (!hasStorage(this.win)) return null;
    try {
      return safeJsonParse<TState>(this.win.localStorage.getItem(this.stateKey));
    } catch {
      return null;
    }
  }

  private writeStoredState(value: TState | null): void {
    if (!hasStorage(this.win)) return;
    try {
      if (value == null) this.win.localStorage.removeItem(this.stateKey);
      else this.win.localStorage.setItem(this.stateKey, safeJsonStringify(value));
    } catch {
      /* quota or disabled — drop silently */
    }
  }

  // -----------------------------------------------------------------------
  // Internals — locks
  // -----------------------------------------------------------------------

  private lockKey(name: string): string {
    return `${this.lockKeyPrefix}${name}`;
  }

  private readLock(name: string): LockRecord | null {
    if (!hasStorage(this.win)) return null;
    return safeJsonParse<LockRecord>(this.win.localStorage.getItem(this.lockKey(name)));
  }

  private writeLock(name: string, record: LockRecord | null): void {
    if (!hasStorage(this.win)) return;
    const key = this.lockKey(name);
    try {
      if (record == null) this.win.localStorage.removeItem(key);
      else this.win.localStorage.setItem(key, safeJsonStringify(record));
    } catch {
      /* drop silently */
    }
  }

  private async acquireLock(name: string, options: LockOptions): Promise<string> {
    if (!hasStorage(this.win)) {
      throw new Error('[TabJS] lock() requires localStorage');
    }
    const timeoutMs = options.timeout ?? 30_000;
    const pollMs = options.pollInterval ?? 50;
    const staleAfter = options.staleAfter ?? 5_000;
    const deadline = now() + timeoutMs;
    const token = makeId('lk');

    while (true) {
      const existing = this.readLock(name);
      const fresh = existing && now() - existing.heartbeat < staleAfter;
      if (!fresh) {
        const record: LockRecord = {
          owner: this.id,
          token,
          acquiredAt: now(),
          heartbeat: now(),
        };
        this.writeLock(name, record);
        // CAS check — race with another tab on the same fallback storage.
        const check = this.readLock(name);
        if (check && check.token === token) {
          this.heldLocks.set(name, {
            token,
            release: () => this.releaseLock(name, token),
          });
          return token;
        }
      }
      if (now() >= deadline) {
        throw new Error(`[TabJS] lock "${name}" timed out after ${timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => this.win.setTimeout(resolve, pollMs));
    }
  }

  private releaseLock(name: string, token: string): void {
    const existing = this.readLock(name);
    if (existing && existing.token === token) {
      this.writeLock(name, null);
      this.broadcastEnvelope(KIND_LOCK_RELEASE, name, null, null);
    }
    this.heldLocks.delete(name);
  }

  /** Refresh held locks so other tabs don't consider them stale. */
  private refreshHeldLocks(): void {
    if (this.heldLocks.size === 0) return;
    for (const [name, held] of this.heldLocks) {
      const existing = this.readLock(name);
      if (!existing || existing.token !== held.token) {
        // Someone stole it — drop our reference.
        this.heldLocks.delete(name);
        continue;
      }
      existing.heartbeat = now();
      this.writeLock(name, existing);
    }
  }
}
