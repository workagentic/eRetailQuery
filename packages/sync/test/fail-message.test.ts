import { describe, expect, it } from 'vitest';
import { safeMessage } from '../src/engine/fail';

describe('safeMessage', () => {
  it('sanitizes before storing', () => {
    expect(safeMessage(new Error('bad token shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'))).not.toMatch(
      /shpat_/,
    );
  });
});
