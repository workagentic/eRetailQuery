import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, nextCursorOf, PermanentError } from '../src';

describe('cursor', () => {
  it('round-trips and keeps null', () => {
    expect(decodeCursor(null)).toBeNull();
    for (const after of [null, 'eyJsYXN0X2lkIjoxMjM0fQ==', 'a/b+c=', '0'])
      expect(decodeCursor(encodeCursor(after))).toBe(after);
    expect(encodeCursor('x')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it.each([
    '',
    'abc',
    '!!!',
    'e30', // not valid / not our shape
    Buffer.from('{"v":2,"after":null}').toString('base64url'),
    Buffer.from('{"v":1,"after":null,"x":1}').toString('base64url'),
    Buffer.from('{"v":1,"after":""}').toString('base64url'),
    Buffer.from('{"v":1,"after":5}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    Buffer.from('{"v":1,"after":null}').toString('base64'), // standard base64 with padding: not canonical
  ])('rejects %j', (bad) => {
    expect(() => decodeCursor(bad)).toThrow(PermanentError);
  });
  it('nextCursorOf ends, continues, and refuses hasNextPage without an endCursor', () => {
    expect(nextCursorOf({ hasNextPage: false, endCursor: 'x' })).toBeNull();
    expect(decodeCursor(nextCursorOf({ hasNextPage: true, endCursor: 'x' }))).toBe('x');
    expect(() => nextCursorOf({ hasNextPage: true, endCursor: null })).toThrow(PermanentError);
  });
});
