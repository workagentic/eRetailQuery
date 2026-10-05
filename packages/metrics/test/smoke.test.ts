import { describe, expect, it } from 'vitest';
import { METRICS_PACKAGE } from '../src';

describe('metrics package', () => {
  it('loads', () => {
    expect(METRICS_PACKAGE).toBe('@erq/metrics');
  });
});
