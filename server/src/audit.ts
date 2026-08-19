import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';

export class AuditService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: string;

  constructor(config: AppConfig, private readonly database: Database) {
    const keyPath = config.audit.privateKeyPath;
    mkdirSync(path.dirname(keyPath), { recursive: true });
    if (!existsSync(keyPath)) {
      const generated = generateKeyPairSync('ed25519');
      writeFileSync(
        keyPath,
        generated.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
    }
    this.privateKey = createPrivateKey(readFileSync(keyPath));
    this.publicKey = createPublicKey(this.privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
  }

  async signRecord(userId: string, record: unknown) {
    const serialized = JSON.stringify(record);
    const digest = createHash('sha256').update(serialized).digest('hex');
    const signature = sign(null, Buffer.from(digest, 'hex'), this.privateKey).toString('base64');
    const envelope = {
      algorithm: 'Ed25519-SHA256',
      digest,
      signature,
      publicKey: this.publicKey,
      signedAt: new Date().toISOString(),
      recordId: digest,
      downloadUrl: `/claimtrace-audit/${digest}`,
    };
    await this.database.execute(
      `INSERT INTO audit_records (digest, user_id, algorithm, signature, public_key, record_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE signature=VALUES(signature), public_key=VALUES(public_key)`,
      [digest, userId, envelope.algorithm, signature, this.publicKey, serialized],
    );
    return envelope;
  }
}
