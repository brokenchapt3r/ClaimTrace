import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class CredentialCipher {
  private constructor(private readonly key: Buffer) {}

  static async create(keyPath: string) {
    await mkdir(path.dirname(keyPath), { recursive: true });
    let key: Buffer;
    try {
      key = await readFile(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32);
      await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
    }
    if (key.length !== 32) throw new Error('Model credential key must contain exactly 32 bytes');
    await chmod(keyPath, 0o600);
    return new CredentialCipher(key);
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  decrypt(envelope: string) {
    const [version, iv, tag, encrypted] = envelope.split('.');
    if (version !== 'v1' || !iv || !tag || encrypted === undefined) {
      throw new Error('Unsupported model credential envelope');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
