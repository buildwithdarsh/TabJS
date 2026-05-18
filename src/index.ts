export { TabManager } from './manager.js';
export { Transport } from './transport.js';

export type {
  Envelope,
  LineageId,
  Listener,
  LockOptions,
  MessageHandler,
  RequestOptions,
  TabCloseEvent,
  TabDuplicateEvent,
  TabEvent,
  TabEventType,
  TabFocusEvent,
  TabId,
  TabInfo,
  TabLeaderEvent,
  TabMessageEvent,
  TabMetrics,
  TabOpenEvent,
  TabStateEvent,
  TabManagerOptions,
  Unsubscribe,
} from './types.js';

import { TabManager } from './manager.js';
import type { TabManagerOptions } from './types.js';

let singleton: TabManager<unknown, unknown> | null = null;

/**
 * Lazy singleton — convenient for app code that just wants "the" tab manager.
 * Pass options the first time to configure. Subsequent calls ignore options.
 * Use `new TabManager()` directly if you need multiple instances.
 */
export function getTabs<TState = unknown, TPayload = unknown>(
  options?: TabManagerOptions<TState>,
): TabManager<TState, TPayload> {
  if (!singleton) {
    singleton = new TabManager<unknown, unknown>(options as TabManagerOptions<unknown>);
  }
  return singleton as unknown as TabManager<TState, TPayload>;
}

/** Reset the singleton — primarily for tests. */
export function resetTabsSingleton(): void {
  singleton?.destroy();
  singleton = null;
}

const defaultExport = Object.assign(getTabs, {
  TabManager,
  getTabs,
  resetTabsSingleton,
});

export default defaultExport;
