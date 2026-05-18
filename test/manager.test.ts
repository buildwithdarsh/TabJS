import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../src/manager.js';
import type { TabEvent } from '../src/types.js';

const NS_COUNTER = { n: 0 };
const ns = () => `tabjs_test_${Date.now()}_${++NS_COUNTER.n}`;

describe('TabManager — single tab', () => {
  let manager: TabManager<{ theme?: string }>;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    manager = new TabManager<{ theme?: string }>({ namespace: ns() });
  });

  afterEach(() => {
    manager.destroy();
  });

  it('assigns a stable tab id and lineage', () => {
    expect(manager.id).toMatch(/^tab_/);
    expect(manager.lineage).toMatch(/^lin_/);
    expect(manager.bornAt).toBeGreaterThan(0);
  });

  it('registers itself as the sole tab and elects itself leader', () => {
    expect(manager.tabs).toHaveLength(1);
    expect(manager.tabs[0].id).toBe(manager.id);
    expect(manager.isLeader).toBe(true);
    expect(manager.leader?.id).toBe(manager.id);
  });

  it('updates and reads shared state', () => {
    expect(manager.getState()).toBeNull();
    manager.setState({ theme: 'dark' });
    expect(manager.getState()).toEqual({ theme: 'dark' });
  });

  it('emits a state event when setState is called', () => {
    const events: TabEvent<{ theme?: string }>[] = [];
    manager.subscribe((e) => events.push(e));
    manager.setState({ theme: 'dark' });
    const stateEvt = events.find((e) => e.type === 'state');
    expect(stateEvt).toBeDefined();
    if (stateEvt && stateEvt.type === 'state') {
      expect(stateEvt.state).toEqual({ theme: 'dark' });
      expect(stateEvt.from).toBe(manager.id);
    }
  });

  it('supports the updater form of setState', () => {
    manager.setState({ theme: 'dark' });
    manager.setState((prev) => ({ ...prev, theme: 'light' }));
    expect(manager.getState()).toEqual({ theme: 'light' });
  });

  it('unsubscribe stops calling the listener', () => {
    const fn = vi.fn();
    const off = manager.subscribe(fn);
    manager.setState({ theme: 'dark' });
    off();
    manager.setState({ theme: 'light' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('on() filters by event type', () => {
    const stateFn = vi.fn();
    const openFn = vi.fn();
    manager.on('state', stateFn);
    manager.on('open', openFn);
    manager.setState({ theme: 'dark' });
    expect(stateFn).toHaveBeenCalledTimes(1);
    expect(openFn).not.toHaveBeenCalled();
  });

  it('tracks metrics for state updates and broadcasts', () => {
    manager.setState({ theme: 'dark' });
    manager.broadcast('ping', { hello: 'world' });
    expect(manager.metrics.stateUpdates).toBe(1);
    expect(manager.metrics.broadcasts).toBe(1);
    expect(manager.metrics.messagesSent).toBeGreaterThan(0);
  });

  it('setMeta updates the meta on this tab info snapshot', () => {
    manager.setMeta({ role: 'admin' });
    expect(manager.info.meta).toEqual({ role: 'admin' });
  });

  it('isDuplicate is false when no other tabs share the lineage', () => {
    expect(manager.isDuplicate).toBe(false);
  });

  it('handle() registers a message handler', () => {
    const handler = vi.fn(() => 'ok');
    const off = manager.handle('greet', handler);
    expect(typeof off).toBe('function');
    off();
  });

  it('initialState seeds shared state when storage is empty', () => {
    manager.destroy();
    window.localStorage.clear();
    manager = new TabManager<{ theme?: string }>({
      namespace: ns(),
      initialState: { theme: 'dark' },
    });
    expect(manager.getState()).toEqual({ theme: 'dark' });
  });

  it('reads existing shared state from storage on construction', () => {
    const namespace = ns();
    const a = new TabManager<{ theme?: string }>({ namespace });
    a.setState({ theme: 'dark' });
    a.destroy();
    const b = new TabManager<{ theme?: string }>({ namespace });
    expect(b.getState()).toEqual({ theme: 'dark' });
    b.destroy();
  });

  it('destroy cleans up and stops emitting events', () => {
    const fn = vi.fn();
    manager.subscribe(fn);
    manager.destroy();
    manager.setState({ theme: 'dark' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('destroyed manager rejects pending requests', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace });
    const b = new TabManager({ namespace });
    // Wait a tick for cross-registration
    await new Promise((r) => setTimeout(r, 50));

    const promise = a.request(b.id, 'never', null, { timeout: 5000 });
    a.destroy();
    await expect(promise).rejects.toThrow(/destroyed/);
    b.destroy();
  });
});

describe('TabManager — cross tab via BroadcastChannel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('two tabs see each other via heartbeats', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });

    await new Promise((r) => setTimeout(r, 120));

    expect(a.tabs.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(b.tabs.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    a.destroy();
    b.destroy();
  });

  it('elects the older tab as leader', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    // Force b to be born after a
    await new Promise((r) => setTimeout(r, 10));
    const b = new TabManager({ namespace, heartbeatInterval: 50 });

    await new Promise((r) => setTimeout(r, 120));

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(b.leader?.id).toBe(a.id);

    a.destroy();
    b.destroy();
  });

  it('broadcast reaches other tabs', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    const received: unknown[] = [];
    b.on('message', (e) => {
      if (e.channel === 'ping') received.push(e.payload);
    });

    a.broadcast('ping', { n: 1 });
    a.broadcast('ping', { n: 2 });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    a.destroy();
    b.destroy();
  });

  it('send delivers only to the targeted tab', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    const c = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    const bMsgs: unknown[] = [];
    const cMsgs: unknown[] = [];
    b.on('message', (e) => bMsgs.push(e.payload));
    c.on('message', (e) => cMsgs.push(e.payload));

    a.send(b.id, 'whisper', { secret: 1 });
    await new Promise((r) => setTimeout(r, 50));

    expect(bMsgs).toEqual([{ secret: 1 }]);
    expect(cMsgs).toEqual([]);

    a.destroy();
    b.destroy();
    c.destroy();
  });

  it('request/handle round-trips a value', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    b.handle<{ x: number }, number>('double', ({ x }) => x * 2);

    const result = await a.request<{ x: number }, number>(b.id, 'double', { x: 21 });
    expect(result).toBe(42);

    a.destroy();
    b.destroy();
  });

  it('request rejects on timeout when no handler is registered', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    await expect(a.request(b.id, 'nope', null, { timeout: 200 })).rejects.toThrow(/no handler/);

    a.destroy();
    b.destroy();
  });

  it('setState in one tab updates state in another', async () => {
    const namespace = ns();
    const a = new TabManager<{ count: number }>({ namespace, heartbeatInterval: 50 });
    const b = new TabManager<{ count: number }>({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    a.setState({ count: 7 });
    await new Promise((r) => setTimeout(r, 50));

    expect(b.getState()).toEqual({ count: 7 });

    a.destroy();
    b.destroy();
  });

  it('new tabs receive existing state from a peer (state-get)', async () => {
    const namespace = ns();
    const a = new TabManager<{ pre: number }>({ namespace, heartbeatInterval: 50 });
    a.setState({ pre: 99 });
    await new Promise((r) => setTimeout(r, 30));

    // Clear storage to force b to ask peers — sessionStorage / localStorage are global per origin in happy-dom.
    window.localStorage.removeItem(`__${namespace}__state__`);

    const b = new TabManager<{ pre: number }>({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    expect(b.getState()).toEqual({ pre: 99 });

    a.destroy();
    b.destroy();
  });

  it('detects duplicate tabs sharing a sessionStorage lineage', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    // Both managers in the same realm share sessionStorage → both end up with the same lineage,
    // which simulates a duplicated tab in a real browser.
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    expect(a.lineage).toBe(b.lineage);
    expect(a.isDuplicate).toBe(true);
    expect(b.isDuplicate).toBe(true);

    a.destroy();
    b.destroy();
  });

  it('emits a close event when a peer is destroyed', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    const closed: string[] = [];
    a.on('close', (e) => closed.push(e.tab.id));

    b.destroy();
    await new Promise((r) => setTimeout(r, 50));

    expect(closed).toContain(b.id);

    a.destroy();
  });

  it('promotes a new leader when the leader leaves', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 10));
    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await new Promise((r) => setTimeout(r, 80));

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);

    const leaderChanges: string[] = [];
    b.on('leader', (e) => leaderChanges.push(e.leader.id));

    a.destroy();
    await new Promise((r) => setTimeout(r, 80));

    expect(b.isLeader).toBe(true);
    expect(leaderChanges).toContain(b.id);

    b.destroy();
  });
});

describe('TabManager — locks', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('runs the critical section under a held lock', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });

    const result = await a.lock('shared', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });

    expect(result).toBe('done');
    expect(a.metrics.locksAcquired).toBe(1);
    a.destroy();
  });

  it('serializes two contenders for the same lock', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });
    const b = new TabManager({ namespace, heartbeatInterval: 50 });

    const order: string[] = [];
    const runA = a.lock('mutex', async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 80));
      order.push('a:end');
    });
    // Tiny delay so a wins the race deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const runB = b.lock('mutex', async () => {
      order.push('b:start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('b:end');
    });

    await Promise.all([runA, runB]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

    a.destroy();
    b.destroy();
  });

  it('rejects when acquisition times out', async () => {
    const namespace = ns();
    const a = new TabManager({ namespace, heartbeatInterval: 50 });

    // Hold a lock outside the wrapper so it never releases.
    let releaseHeld: () => void = () => {};
    const heldPromise = a.lock('busy', () => new Promise<void>((resolve) => {
      releaseHeld = resolve;
    }));
    await new Promise((r) => setTimeout(r, 10));

    const b = new TabManager({ namespace, heartbeatInterval: 50 });
    await expect(
      b.lock('busy', () => 'never', { timeout: 100, staleAfter: 10_000 }),
    ).rejects.toThrow(/timed out/);

    releaseHeld();
    await heldPromise;

    a.destroy();
    b.destroy();
  });
});
