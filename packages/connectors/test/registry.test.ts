import { describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors';
import { ConnectorRegistry } from '../src/registry';
import type { StoreConnector } from '../src/types';

const stub = {} as unknown as StoreConnector; // identity is all the registry cares about

describe('ConnectorRegistry', () => {
  it('returns the registered connector for a platform', () => {
    const r = new ConnectorRegistry().register('shopify', stub);
    expect(r.has('shopify')).toBe(true);
    expect(r.get('shopify')).toBe(stub);
  });
  it('throws a PermanentError for an unknown platform', () => {
    const r = new ConnectorRegistry();
    expect(r.has('amazon')).toBe(false);
    expect(() => r.get('amazon')).toThrow(PermanentError);
  });
  it('refuses to register a platform twice', () => {
    const r = new ConnectorRegistry().register('shopify', stub);
    expect(() => r.register('shopify', stub)).toThrow(/already registered/);
  });
});
