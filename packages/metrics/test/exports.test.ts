import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as metrics from '../src';

describe('@erq/metrics public API', () => {
  it.each([
    'divRound',
    'toSafeInteger',
    'mulDivRound',
    'bigRatioToBps',
    'ratioToBps',
    'moneyRatioBps',
    'formatBps',
    'isCostInEffect',
    'landedCost',
    'skuPricing',
    'roas',
    'blendedRoas',
    'breakEvenRoas',
    'cpa',
    'classifyAd',
    'salesVelocity',
    'daysOfCover',
    'stockFlags',
    'stockByLocation',
    'buildPnl',
    'sumPnl',
    'comparePnl',
  ])('exports the function %s', (name) => {
    expect(typeof (metrics as Record<string, unknown>)[name]).toBe('function');
  });
  it.each([
    'DEFAULT_PRICING_CONFIG',
    'DEFAULT_AD_FLAG_CONFIG',
    'DEFAULT_BUFFER_DAYS',
    'UNKNOWN_LEAD_TIME_DAYS',
    'DEFAULT_OVERSTOCK_DAYS',
  ])('exports the constant %s', (name) => {
    expect((metrics as Record<string, unknown>)[name]).toBeDefined();
  });
  it.each(['assemble', 'fixedTotal', 'percentTotal', 'withDefaults'])(
    'does not expose the internal %s',
    (name) => {
      expect((metrics as Record<string, unknown>)[name]).toBeUndefined();
    },
  );
  it('depends only on @erq/shared at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@erq/shared']);
  });
});
