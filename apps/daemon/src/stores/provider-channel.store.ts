import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";

// =============================================================================
// Types
// =============================================================================

export interface ProviderChannel {
  id: string;
  ticketId?: string;
  brainstormId?: string;
  providerId: string;
  channelId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CreateChannelInput {
  ticketId?: string;
  brainstormId?: string;
  providerId: string;
  channelId: string;
  metadata?: Record<string, unknown>;
}

export interface ListChannelsOptions {
  ticketId?: string;
  brainstormId?: string;
}

// =============================================================================
// Row Types
// =============================================================================

interface ChannelRow {
  id: string;
  ticket_id: string | null;
  brainstorm_id: string | null;
  provider_id: string;
  channel_id: string;
  metadata: string | null;
  created_at: string;
}

// =============================================================================
// Row Mappers
// =============================================================================

function rowToChannel(row: ChannelRow): ProviderChannel {
  return {
    id: row.id,
    ticketId: row.ticket_id || undefined,
    brainstormId: row.brainstorm_id || undefined,
    providerId: row.provider_id,
    channelId: row.channel_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}

// =============================================================================
// ProviderChannelStore Class
// =============================================================================

export class ProviderChannelStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  createChannel(input: CreateChannelInput): ProviderChannel {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO provider_channels (id, ticket_id, brainstorm_id, provider_id, channel_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.ticketId || null,
        input.brainstormId || null,
        input.providerId,
        input.channelId,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now
      );

    return this.getChannel(id)!;
  }

  getChannel(id: string): ProviderChannel | null {
    const row = this.db
      .prepare("SELECT * FROM provider_channels WHERE id = ?")
      .get(id) as ChannelRow | undefined;

    return row ? rowToChannel(row) : null;
  }

  getChannelForTicket(
    ticketId: string,
    providerId: string
  ): ProviderChannel | null {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_channels WHERE ticket_id = ? AND provider_id = ?"
      )
      .get(ticketId, providerId) as ChannelRow | undefined;

    return row ? rowToChannel(row) : null;
  }

  getChannelForBrainstorm(
    brainstormId: string,
    providerId: string
  ): ProviderChannel | null {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_channels WHERE brainstorm_id = ? AND provider_id = ?"
      )
      .get(brainstormId, providerId) as ChannelRow | undefined;

    return row ? rowToChannel(row) : null;
  }

  /**
   * Reverse lookup: find channel by provider and external channel ID.
   * Used for routing incoming messages from providers back to tickets/brainstorms.
   */
  findChannelByProviderChannel(
    providerId: string,
    channelId: string
  ): ProviderChannel | null {
    return this.findChannelByProviderRoute(providerId, channelId);
  }

  /**
   * Reverse lookup by provider route identity.
   * If externalThreadId is provided, route resolution includes thread/topic metadata.
   */
  findChannelByProviderRoute(
    providerId: string,
    channelId: string,
    externalThreadId?: string | number
  ): ProviderChannel | null {
    if (externalThreadId === undefined || externalThreadId === null) {
      const row = this.db
        .prepare(
          "SELECT * FROM provider_channels WHERE provider_id = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(providerId, channelId) as ChannelRow | undefined;

      return row ? rowToChannel(row) : null;
    }

    const threadText = String(externalThreadId);
    const row = this.db
      .prepare(
        `SELECT * FROM provider_channels
         WHERE provider_id = ? AND channel_id = ?
           AND (
             CAST(json_extract(metadata, '$.messageThreadId') AS TEXT) = ?
             OR CAST(json_extract(metadata, '$.threadTs') AS TEXT) = ?
             OR CAST(json_extract(metadata, '$.externalThreadId') AS TEXT) = ?
           )
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(providerId, channelId, threadText, threadText, threadText) as
      | ChannelRow
      | undefined;

    return row ? rowToChannel(row) : null;
  }

  listChannels(options?: ListChannelsOptions): ProviderChannel[] {
    let sql = "SELECT * FROM provider_channels";
    const params: string[] = [];
    const conditions: string[] = [];

    if (options?.ticketId) {
      conditions.push("ticket_id = ?");
      params.push(options.ticketId);
    }

    if (options?.brainstormId) {
      conditions.push("brainstorm_id = ?");
      params.push(options.brainstormId);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY created_at";

    const rows = this.db.prepare(sql).all(...params) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  deleteChannel(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM provider_channels WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  deleteChannelsForTicket(ticketId: string): number {
    const result = this.db
      .prepare("DELETE FROM provider_channels WHERE ticket_id = ?")
      .run(ticketId);
    return result.changes;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createProviderChannelStore(
  db: Database.Database
): ProviderChannelStore {
  return new ProviderChannelStore(db);
}

// Singleton convenience functions
export function createProviderChannel(
  input: CreateChannelInput
): ProviderChannel {
  return new ProviderChannelStore(getDatabase()).createChannel(input);
}

export function getProviderChannel(id: string): ProviderChannel | null {
  return new ProviderChannelStore(getDatabase()).getChannel(id);
}

export function getProviderChannelForTicket(
  ticketId: string,
  providerId: string
): ProviderChannel | null {
  return new ProviderChannelStore(getDatabase()).getChannelForTicket(
    ticketId,
    providerId
  );
}

export function getProviderChannelForBrainstorm(
  brainstormId: string,
  providerId: string
): ProviderChannel | null {
  return new ProviderChannelStore(getDatabase()).getChannelForBrainstorm(
    brainstormId,
    providerId
  );
}

export function findProviderChannelByProviderChannel(
  providerId: string,
  channelId: string
): ProviderChannel | null {
  return new ProviderChannelStore(getDatabase()).findChannelByProviderRoute(
    providerId,
    channelId
  );
}

export function findProviderChannelByProviderRoute(
  providerId: string,
  channelId: string,
  externalThreadId?: string | number
): ProviderChannel | null {
  return new ProviderChannelStore(getDatabase()).findChannelByProviderRoute(
    providerId,
    channelId,
    externalThreadId
  );
}

export function listProviderChannels(
  options?: ListChannelsOptions
): ProviderChannel[] {
  return new ProviderChannelStore(getDatabase()).listChannels(options);
}

export function deleteProviderChannel(id: string): boolean {
  return new ProviderChannelStore(getDatabase()).deleteChannel(id);
}

export function deleteProviderChannelsForTicket(ticketId: string): number {
  return new ProviderChannelStore(getDatabase()).deleteChannelsForTicket(ticketId);
}
