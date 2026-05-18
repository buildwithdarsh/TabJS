export type TabId = string;

export type LineageId = string;

export interface TabInfo {
  /** Stable per-tab id assigned at construction. */
  id: TabId;
  /** Wall-clock time the tab was opened (used as a tie-breaker for leader election). */
  bornAt: number;
  /** Last-seen heartbeat timestamp from this tab. */
  lastSeen: number;
  /** Is the tab visible/focused? */
  focused: boolean;
  /** Optional metadata the tab attached to itself via setMeta(). */
  meta: Record<string, unknown>;
  /** Where the tab is in the app (window.location.href at the time of last update). */
  url: string;
  /** Lineage id from sessionStorage — duplicated tabs inherit the same lineage. */
  lineage: LineageId;
}

export type TabEventType =
  | 'open'
  | 'close'
  | 'focus'
  | 'blur'
  | 'leader'
  | 'message'
  | 'state'
  | 'duplicate';

export interface TabOpenEvent {
  type: 'open';
  tab: TabInfo;
}
export interface TabCloseEvent {
  type: 'close';
  tab: TabInfo;
}
export interface TabFocusEvent {
  type: 'focus' | 'blur';
  tab: TabInfo;
}
export interface TabLeaderEvent {
  type: 'leader';
  /** The new leader. May be this tab. */
  leader: TabInfo;
  /** The previous leader, if any. */
  previous: TabInfo | null;
}
export interface TabMessageEvent<TPayload = unknown> {
  type: 'message';
  channel: string;
  from: TabId;
  to: TabId | null;
  payload: TPayload;
}
export interface TabStateEvent<TState = unknown> {
  type: 'state';
  state: TState;
  previous: TState | null;
  from: TabId;
}
export interface TabDuplicateEvent {
  type: 'duplicate';
  /** Other live tabs that share this lineage. */
  originals: TabInfo[];
}

export type TabEvent<TState = unknown, TPayload = unknown> =
  | TabOpenEvent
  | TabCloseEvent
  | TabFocusEvent
  | TabLeaderEvent
  | TabMessageEvent<TPayload>
  | TabStateEvent<TState>
  | TabDuplicateEvent;

export type Listener<TState = unknown, TPayload = unknown> = (
  event: TabEvent<TState, TPayload>,
) => void;

export type Unsubscribe = () => void;

export type MessageHandler<TPayload = unknown, TReply = unknown> = (
  payload: TPayload,
  context: { from: TabId; channel: string },
) => TReply | Promise<TReply> | void | Promise<void>;

export interface TabManagerOptions<TState = unknown> {
  /** Override window — useful for testing or iframes. */
  window?: Window;
  /** Namespace used to scope storage keys and broadcast channels. Default: 'tabjs'. */
  namespace?: string;
  /** Initial shared state. Used when no other tab has written state yet. */
  initialState?: TState;
  /** Heartbeat interval in ms. Default: 1500. */
  heartbeatInterval?: number;
  /** Tabs are considered closed after this many ms with no heartbeat. Default: 5000. */
  tabTimeout?: number;
  /** Disable the localStorage fallback and use BroadcastChannel only. Default: false. */
  broadcastChannelOnly?: boolean;
  /** Disable BroadcastChannel and use localStorage only. Default: false. */
  storageOnly?: boolean;
  /** Optional metadata to attach to this tab. */
  meta?: Record<string, unknown>;
}

export interface RequestOptions {
  /** How long to wait before rejecting with a timeout error. Default: 5000ms. */
  timeout?: number;
}

export interface LockOptions {
  /** Max time in ms to wait acquiring the lock before rejecting. Default: 30000. */
  timeout?: number;
  /** Polling interval in ms while waiting for the lock. Default: 50. */
  pollInterval?: number;
  /**
   * Time in ms after which a held lock is considered abandoned (if the holder
   * stops sending heartbeats). Default: 5000.
   */
  staleAfter?: number;
}

/** Snapshot returned by `tabs.metrics`. */
export interface TabMetrics {
  messagesSent: number;
  messagesReceived: number;
  broadcasts: number;
  requests: number;
  responses: number;
  stateUpdates: number;
  locksAcquired: number;
}

/** @internal — wire envelope used by the transport layer. */
export interface Envelope<TPayload = unknown> {
  /** Random id used to deduplicate echoes from the storage fallback. */
  _id: string;
  /** Sender tab id. */
  from: TabId;
  /** Recipient tab id, or null for broadcast. */
  to: TabId | null;
  /** Message kind — used by the manager to dispatch internally. */
  kind: string;
  /** User-visible "channel" / message type. */
  channel: string;
  /** User payload. */
  payload: TPayload;
  /** Sender wall-clock timestamp. */
  ts: number;
}
