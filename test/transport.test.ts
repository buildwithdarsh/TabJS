import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Transport } from '../src/transport.js';
import type { Envelope } from '../src/types.js';

const env = (id: string, partial: Partial<Envelope> = {}): Envelope => ({
  _id: id,
  from: 'tab_x',
  to: null,
  kind: 'msg',
  channel: 'test',
  payload: null,
  ts: Date.now(),
  ...partial,
});

describe('Transport', () => {
  let transports: Transport[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    transports = [];
  });

  afterEach(() => {
    for (const t of transports) t.destroy();
  });

  const make = (namespace: string, opts = {}) => {
    const t = new Transport(window, namespace, opts);
    transports.push(t);
    return t;
  };

  it('delivers messages between two transports on the same channel', async () => {
    const a = make('xport_a');
    const b = make('xport_a');

    const received: Envelope[] = [];
    b.subscribe((e) => received.push(e));

    a.send(env('m1', { from: 'A' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0]._id).toBe('m1');
  });

  it('does not deliver a sender its own message', async () => {
    const a = make('xport_b');
    const seen: Envelope[] = [];
    a.subscribe((e) => seen.push(e));

    a.send(env('self'));
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toHaveLength(0);
  });

  it('dedupes envelopes that arrive twice (channel + storage fallback)', async () => {
    const a = make('xport_c');
    const b = make('xport_c');

    const got: string[] = [];
    b.subscribe((e) => got.push(e._id));

    a.send(env('dup1'));
    a.send(env('dup1'));
    await new Promise((r) => setTimeout(r, 20));

    // Despite two sends with the same id, b should see it at most once.
    expect(got.filter((id) => id === 'dup1')).toHaveLength(1);
  });

  it('isLive reports false after destroy', () => {
    const a = make('xport_d');
    expect(a.isLive).toBe(true);
    a.destroy();
    expect(a.isLive).toBe(false);
  });
});
