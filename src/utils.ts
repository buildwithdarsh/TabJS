let idCounter = 0;

export function makeId(prefix = 'tab'): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${rand}`;
}

export function safeJsonParse<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function now(): number {
  return Date.now();
}

/** Lazy global window resolver — throws a clear error if no window is available. */
export function resolveWindow(maybeWin?: Window): Window {
  if (maybeWin) return maybeWin;
  if (typeof window !== 'undefined') return window;
  throw new Error(
    '[tab.js] TabManager requires a window. Pass `options.window` when running outside the browser.',
  );
}

export function hasBroadcastChannel(win: Window): boolean {
  return typeof (win as unknown as { BroadcastChannel?: unknown }).BroadcastChannel === 'function';
}

export function hasStorage(win: Window): boolean {
  try {
    return typeof win.localStorage !== 'undefined' && win.localStorage !== null;
  } catch {
    return false;
  }
}
