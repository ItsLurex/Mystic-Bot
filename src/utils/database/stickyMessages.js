// stickyMessages.js
//
// Repository layer for the Sticky Messages feature.
//
// This is the ONLY module allowed to touch SQL for sticky messages. Commands
// and services must go through src/services/stickyService.js, which in turn
// calls the functions exported here — mirroring the existing tickets.js
// repository pattern (dedicated relational table, direct pool access when
// PostgreSQL is reachable, in-memory KV fallback when it is degraded).

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getStickyKey, getStickyGuildPrefix } from './keys.js';

/**
 * Whether the underlying PostgreSQL pool is connected and reachable.
 * When false, all functions below transparently fall back to the
 * in-memory/degraded key-value store so the feature keeps working
 * (without persistence) instead of throwing.
 */
function isSqlReady() {
    return Boolean(
        db.db?.pool &&
        typeof db.db.isAvailable === 'function' &&
        db.db.isAvailable(),
    );
}

async function ensureInitialized() {
    if (!db.initialized) {
        await db.initialize();
    }
}

/**
 * Maps a raw sticky_messages SQL row into the canonical shape used
 * throughout the feature (camelCase, consistent field names).
 */
function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        messageContent: row.message_content,
        embedJson: row.embed_json || null,
        enabled: Boolean(row.enabled),
        lastMessageId: row.last_message_id,
        messageCounter: Number(row.message_counter) || 0,
        threshold: Number(row.threshold) || 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Normalizes a degraded-mode (in-memory) record into the same canonical shape. */
function mapMemoryRecord(record) {
    if (!record) return null;
    return {
        id: record.id,
        guildId: record.guildId,
        channelId: record.channelId,
        messageContent: record.messageContent ?? null,
        embedJson: record.embedJson ?? null,
        enabled: Boolean(record.enabled),
        lastMessageId: record.lastMessageId ?? null,
        messageCounter: Number(record.messageCounter) || 0,
        threshold: Number(record.threshold) || 1,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}

async function getTables() {
    const { pgConfig } = await import('../../config/database/postgres.js');
    return pgConfig.tables;
}

/**
 * Fetch the single sticky configured for a channel (a channel may only have one).
 */
export async function getStickyByChannel(guildId, channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.sticky_messages} WHERE guild_id = $1 AND channel_id = $2`,
                [guildId, channelId],
            );
            return mapRow(result.rows[0]);
        }

        const record = await getFromDb(getStickyKey(guildId, channelId), null);
        return mapMemoryRecord(record);
    } catch (error) {
        logger.error(`Error fetching sticky for channel ${channelId} in guild ${guildId}:`, error);
        throw error;
    }
}

/**
 * Fetch every sticky message for a guild (used by /sticky list).
 */
export async function listStickiesForGuild(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.sticky_messages} WHERE guild_id = $1 ORDER BY created_at ASC`,
                [guildId],
            );
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') {
            return [];
        }

        const keys = await db.list(getStickyGuildPrefix(guildId));
        const stickies = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) stickies.push(mapMemoryRecord(record));
        }
        return stickies;
    } catch (error) {
        logger.error(`Error listing stickies for guild ${guildId}:`, error);
        throw error;
    }
}

/**
 * Fetch every sticky message across all guilds. Used once at startup to warm
 * the in-memory cache (see stickyService.initializeStickyCache).
 */
export async function getAllStickies() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.sticky_messages}`);
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') {
            return [];
        }

        const keys = await db.list('guild:');
        const stickies = [];
        for (const key of keys) {
            if (!key.includes(':sticky:')) continue;
            const record = await getFromDb(key, null);
            if (record) stickies.push(mapMemoryRecord(record));
        }
        return stickies;
    } catch (error) {
        logger.error('Error loading all stickies from the database:', error);
        return [];
    }
}

/**
 * Create a new sticky for a channel. Throws if one already exists for that
 * channel (enforced at the SQL level by the UNIQUE(guild_id, channel_id)
 * constraint, and mirrored in degraded mode).
 */
export async function createSticky({
    guildId,
    channelId,
    messageContent = null,
    embedJson = null,
    threshold = 1,
}) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();

            // Sticky rows carry a guild_id FK — make sure the parent guild row exists.
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at)
                 VALUES ($1, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );

            const result = await db.db.pool.query(
                `INSERT INTO ${tables.sticky_messages}
                    (guild_id, channel_id, message_content, embed_json, enabled, threshold, message_counter)
                 VALUES ($1, $2, $3, $4, TRUE, $5, 0)
                 RETURNING *`,
                [guildId, channelId, messageContent, embedJson, threshold],
            );
            return mapRow(result.rows[0]);
        }

        const key = getStickyKey(guildId, channelId);
        const existing = await getFromDb(key, null);
        if (existing) {
            throw new Error(`A sticky already exists for channel ${channelId}`);
        }

        const record = {
            id: `${guildId}:${channelId}`,
            guildId,
            channelId,
            messageContent,
            embedJson,
            enabled: true,
            lastMessageId: null,
            messageCounter: 0,
            threshold,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        await db.set(key, record);
        return mapMemoryRecord(record);
    } catch (error) {
        logger.error(`Error creating sticky for channel ${channelId} in guild ${guildId}:`, error);
        throw error;
    }
}

const UPDATABLE_COLUMNS = {
    messageContent: 'message_content',
    embedJson: 'embed_json',
    enabled: 'enabled',
    threshold: 'threshold',
    lastMessageId: 'last_message_id',
    messageCounter: 'message_counter',
};

/**
 * Partially update a sticky row without deleting it. Accepts any combination
 * of messageContent, embedJson, enabled, threshold, lastMessageId, messageCounter.
 */
export async function updateSticky(guildId, channelId, updates = {}) {
    await ensureInitialized();

    const keys = Object.keys(updates).filter((key) => key in UPDATABLE_COLUMNS);
    if (keys.length === 0) {
        return getStickyByChannel(guildId, channelId);
    }

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const setClauses = keys.map((key, index) => `${UPDATABLE_COLUMNS[key]} = $${index + 3}`);
            const values = keys.map((key) => updates[key]);

            const result = await db.db.pool.query(
                `UPDATE ${tables.sticky_messages}
                 SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = $1 AND channel_id = $2
                 RETURNING *`,
                [guildId, channelId, ...values],
            );
            return mapRow(result.rows[0]);
        }

        const key = getStickyKey(guildId, channelId);
        const existing = await getFromDb(key, null);
        if (!existing) {
            return null;
        }

        const merged = {
            ...existing,
            ...updates,
            updatedAt: new Date().toISOString(),
        };
        await db.set(key, merged);
        return mapMemoryRecord(merged);
    } catch (error) {
        logger.error(`Error updating sticky for channel ${channelId} in guild ${guildId}:`, error);
        throw error;
    }
}

/**
 * Permanently delete a sticky's database row.
 * @returns {Promise<boolean>} true if a row was deleted
 */
export async function deleteSticky(guildId, channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.sticky_messages} WHERE guild_id = $1 AND channel_id = $2 RETURNING id`,
                [guildId, channelId],
            );
            return result.rows.length > 0;
        }

        const key = getStickyKey(guildId, channelId);
        const existing = await getFromDb(key, null);
        if (!existing) {
            return false;
        }
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting sticky for channel ${channelId} in guild ${guildId}:`, error);
        throw error;
    }
}
