# TabJS

Cross-tab communication for the modern web — shared state, presence, leader election, locks, duplicate detection, and request/response between every open tab of your app.

[![npm](https://img.shields.io/badge/npm-v1.0.0-bf5af2)](https://www.npmjs.com/package/@buildwithdarsh/tabjs)
[![bundle](https://img.shields.io/badge/gzipped-~3KB-2997ff)](#)
[![license](https://img.shields.io/badge/license-MIT-30d158)](LICENSE)
[![types](https://img.shields.io/badge/TypeScript-first-2997ff)](#)

Built on `BroadcastChannel` where available, with a `localStorage`-event fallback so it works in every modern browser, including private mode and sandboxed iframes. Zero dependencies, ~3 KB gzipped, fully typed.

## Install

```bash
npm install @buildwithdarsh/tabjs
# or
pnpm add @buildwithdarsh/tabjs
# or
yarn add @buildwithdarsh/tabjs
```

Or via CDN:

```html
<script src="https://unpkg.com/@buildwithdarsh/tabjs"></script>
```

## Quick start

```ts
import { getTabs } from '@buildwithdarsh/tabjs';

type AppState = { theme: 'dark' | 'light'; counter: number };

const tabs = getTabs<AppState>({ initialState: { theme: 'dark', counter: 0 } });

// Listen to everything
tabs.subscribe((event) => {
  console.log(event.type, event);
});

// Shared state — synced to every tab
tabs.setState((s) => ({ ...s!, counter: s!.counter + 1 }));

// Broadcast
tabs.broadcast('logout');

// Direct send to one tab
tabs.send(targetId, 'focus-input', { selector: '#title' });

// RPC
tabs.handle('double', ({ x }) => x * 2);
const result = await tabs.request<{ x: number }, number>(targetId, 'double', { x: 21 });
// → 42

// Leader election
if (tabs.isLeader) startBackgroundPoller();

// Cross-tab mutex
await tabs.lock('save', async () => {
  await persist();
});

// Duplicate-tab detection
if (tabs.isDuplicate) showDuplicateWarning();
```

## Core concepts

### Tabs & presence

Each tab announces itself on construction and posts a heartbeat (default every 1.5 s). Tabs that stop heartbeating are evicted after `tabTimeout` (default 5 s) and a `close` event fires.

```ts
tabs.id            // stable per-tab id, generated at construction
tabs.bornAt        // wall-clock time the tab opened
tabs.tabs          // snapshot of all known live tabs
tabs.info          // this tab's own snapshot

tabs.on('open',  (e) => console.log('+ tab', e.tab.id));
tabs.on('close', (e) => console.log('- tab', e.tab.id));
tabs.on('focus', (e) => console.log('focus', e.tab.id));
tabs.on('blur',  (e) => console.log('blur',  e.tab.id));
```

`TabInfo` shape:

```ts
{
  id: string;            // stable per-tab
  bornAt: number;        // Date.now() at construction
  lastSeen: number;      // last heartbeat
  focused: boolean;      // visibility + focus
  url: string;           // window.location.href at last update
  meta: Record<string, unknown>;
  lineage: string;       // sessionStorage-scoped — see "duplicate detection"
}
```

### Leader election

The oldest live tab (lowest `bornAt`, ties broken by `id`) is the leader. When the leader leaves, a new one is elected automatically and a `leader` event fires in every tab.

```ts
if (tabs.isLeader) startPolling();

tabs.on('leader', (e) => {
  console.log('new leader', e.leader.id, 'was', e.previous?.id);
  if (e.leader.id === tabs.id) startPolling();
});
```

Use it for "only one tab runs the background poller", "only one tab handles WebSocket reconnection", etc.

### Shared state

One typed state object, synchronized across every open tab. Stored in `localStorage` so new tabs hydrate instantly, and any peer can respond to a state-get request with the live in-memory value.

```ts
tabs.setState({ theme: 'dark', counter: 0 });
tabs.setState((prev) => ({ ...prev!, counter: prev!.counter + 1 }));

tabs.getState();        // → current value, or null
tabs.on('state', (e) => render(e.state));
```

### Messaging

```ts
// Fire-and-forget broadcast to every other tab
tabs.broadcast('chat', { text: 'hi' });

// Direct send to a specific tab
tabs.send(targetId, 'chat', { text: 'just you' });

// Subscribe to incoming messages
tabs.on('message', (e) => {
  if (e.channel === 'chat') console.log(e.from, e.payload);
});
```

### Request / response

Promise-based RPC. Register a handler on one tab, `await` the result on another.

```ts
// Tab A
tabs.handle<{ x: number }, number>('double', ({ x }) => x * 2);

// Tab B
const answer = await tabs.request<{ x: number }, number>(tabAId, 'double', { x: 21 });
// → 42

// Pass `null` as the target to send to the current leader
const r = await tabs.request(null, 'work', payload, { timeout: 3000 });
```

Handlers can be async and may throw — exceptions surface as rejections on the caller.

### Cross-tab locks

A mutex that survives across tabs. The held lock heartbeats — if a holder tab crashes the lock auto-releases after `staleAfter` ms.

```ts
await tabs.lock('save-doc', async () => {
  // only one tab in the origin runs this block at a time
  await persist();
});

// With options
await tabs.lock('queue', work, {
  timeout: 30_000,    // give up acquiring after 30s
  pollInterval: 50,
  staleAfter: 5_000,  // assume the holder died if no heartbeat for 5s
});
```

### Duplicate detection

When a user picks "Duplicate tab" in Chrome/Firefox, the new tab inherits the original's `sessionStorage`. TabJS stamps each tab with a `lineage` id in `sessionStorage` on first run — if a heartbeat arrives from another live tab with the same lineage, this tab is a duplicate.

```ts
if (tabs.isDuplicate) showWarning();

tabs.on('duplicate', (e) => {
  console.log('shares lineage with', e.originals.map((t) => t.id));
});
```

### Singleton tab

Refuse a second tab — close it, redirect it, or show an overlay.

```ts
tabs.singleton((others) => {
  // Called when this tab boots and another is already alive
  location.href = '/already-open';
});
```

### Metadata

Attach arbitrary metadata to this tab so other tabs can see it on the next heartbeat.

```ts
tabs.setMeta({ role: 'admin', viewing: '/dashboard' });
tabs.tabs.find((t) => t.id !== tabs.id)?.meta;
```

### Metrics

```ts
tabs.metrics;
// {
//   messagesSent, messagesReceived,
//   broadcasts, requests, responses,
//   stateUpdates, locksAcquired,
// }
```

## Options

```ts
new TabManager<AppState>({
  namespace: 'myapp',          // scopes storage keys + channel name (default 'tabjs')
  initialState: { ... },        // used only if no peer has state yet
  heartbeatInterval: 1500,      // ms between heartbeats
  tabTimeout: 5000,             // ms after which a silent tab is evicted
  broadcastChannelOnly: false,  // skip the localStorage fallback
  storageOnly: false,           // skip BroadcastChannel
  meta: { role: 'admin' },      // initial metadata for this tab
  window: iframe.contentWindow, // override for tests / iframes
});
```

## Singleton vs. instance

`getTabs()` returns a lazy singleton — convenient for app code. For tests or iframes, instantiate directly:

```ts
import { TabManager, getTabs, resetTabsSingleton } from '@buildwithdarsh/tabjs';

const a = getTabs<MyState>();          // app-wide
const b = new TabManager<MyState>();   // independent instance
resetTabsSingleton();                  // tests
```

## React example

```tsx
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getTabs } from '@buildwithdarsh/tabjs';

const tabs = getTabs<{ theme: 'dark' | 'light' }>();

export function useSharedState() {
  return useSyncExternalStore(
    (cb) => tabs.subscribe(cb),
    () => tabs.getState(),
  );
}

export function useLiveTabs() {
  const [list, setList] = useState(tabs.tabs);
  useEffect(() => tabs.subscribe(() => setList(tabs.tabs)), []);
  return list;
}
```

## Transport details

Each envelope is sent over **both** transports (when available) and deduplicated on receive via a per-instance LRU of message ids:

- **BroadcastChannel** — fast, no storage churn, supported in every modern browser.
- **localStorage `storage` event** — fires in every other tab on the same origin. Used as a fallback for older browsers and for tabs where `BroadcastChannel` is blocked.

Force one or the other with `broadcastChannelOnly: true` or `storageOnly: true`.

## Demo

A full live playground is shipped in `example/index.html` — live tab list, leader badge, shared counter & theme, broadcast/direct/request controls, lock contention, duplicate-tab banner, and a real-time event log.

To run locally:

```bash
npm install
npm run build
npx serve example
```

Then open the URL in two tabs.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # rollup → dist/
npm run dev         # rollup --watch
```

## Publishing

```bash
npm publish --access public
```

The `prepublishOnly` script runs typecheck, tests, and the rollup build.

## License

MIT
