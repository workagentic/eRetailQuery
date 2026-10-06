import { PermanentError } from './errors';
import type { StoreConnector } from './types';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, StoreConnector>();

  register(platform: string, connector: StoreConnector): this {
    if (this.connectors.has(platform))
      throw new Error(`connector for ${platform} already registered`);
    this.connectors.set(platform, connector);
    return this;
  }
  has(platform: string): boolean {
    return this.connectors.has(platform);
  }
  get(platform: string): StoreConnector {
    const connector = this.connectors.get(platform);
    if (!connector) throw new PermanentError(`no connector registered for platform ${platform}`);
    return connector;
  }
}
