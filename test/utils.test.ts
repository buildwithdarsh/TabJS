import { describe, expect, it } from 'vitest';
import { makeId, safeJsonParse, safeJsonStringify, hasStorage, hasBroadcastChannel } from '../src/utils.js';

describe('utils', () => {
  it('makeId produces unique prefixed ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeId('t')));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith('t_')).toBe(true);
  });

  it('safeJsonParse returns null on bad input', () => {
    expect(safeJsonParse<{ a: number }>('{')).toBeNull();
    expect(safeJsonParse<{ a: number }>(null)).toBeNull();
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('safeJsonStringify round-trips with parse', () => {
    const value = { a: 1, b: [true, 'x'] };
    expect(safeJsonParse(safeJsonStringify(value))).toEqual(value);
  });

  it('detects browser-like capabilities in happy-dom', () => {
    expect(hasStorage(window)).toBe(true);
    expect(hasBroadcastChannel(window)).toBe(true);
  });
});
