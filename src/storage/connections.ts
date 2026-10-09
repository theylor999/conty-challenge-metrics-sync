import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { ConnectionRow, ConnectionStatus, Platform } from '../domain/types.ts';

export interface NewConnection {
  creatorId: string;
  platform: Platform;
  accountId: string;
  accessToken: string;
}

export class ConnectionsRepo {
  constructor(private readonly db: Db) {}

  get(id: string): ConnectionRow | undefined {
    return this.db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id);
  }

  findByAccount(platform: Platform, accountId: string): ConnectionRow | undefined {
    return this.db.get<ConnectionRow>(
      'SELECT * FROM connections WHERE platform = ? AND account_id = ?',
      platform,
      accountId,
    );
  }

  listByCreator(creatorId: string): ConnectionRow[] {
    return this.db.all<ConnectionRow>('SELECT * FROM connections WHERE creator_id = ? ORDER BY platform', creatorId);
  }

  create(input: NewConnection, now: string): ConnectionRow {
    const id = `con_${randomUUID()}`;
    this.db.run(
      `INSERT INTO connections (id, creator_id, platform, account_id, access_token, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      input.creatorId,
      input.platform,
      input.accountId,
      input.accessToken,
      now,
      now,
    );
    return this.get(id)!;
  }

  /** Reconnect: new token, back to active. */
  renewToken(id: string, accessToken: string, now: string): void {
    this.db.run(
      `UPDATE connections SET access_token = ?, status = 'active', updated_at = ? WHERE id = ?`,
      accessToken,
      now,
      id,
    );
  }

  setStatus(id: string, status: ConnectionStatus, now: string): void {
    this.db.run('UPDATE connections SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  }
}
