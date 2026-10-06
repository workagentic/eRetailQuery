import { decrypt, encrypt, type KeyProvider } from '@erq/shared';
import { AuthError } from './errors';

/** Additional authenticated data that binds stored credentials to one connection. */
export const credentialsAad = (connectionId: string): string => `connection:${connectionId}`;

export function encryptConnectionCredentials(
  credentials: unknown,
  keyProvider: KeyProvider,
  connectionId: string,
): string {
  return encrypt(JSON.stringify(credentials), keyProvider, credentialsAad(connectionId));
}

/** Null (demo connections) stays null. Any failure becomes an AuthError whose message never contains secret material. */
export function decryptConnectionCredentials(
  encrypted: string | null,
  keyProvider: KeyProvider,
  connectionId: string,
): unknown {
  if (encrypted === null) return null;
  try {
    return JSON.parse(decrypt(encrypted, keyProvider, credentialsAad(connectionId)));
  } catch {
    throw new AuthError('Stored credentials could not be read. Reconnect the store.');
  }
}
