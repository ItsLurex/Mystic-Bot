// autoreact.js
//
// Repository for per-channel Auto-Reaction rules: a channel maps to a list
// of emoji (unicode or custom) that get added to every qualifying message
// sent there. Same dual-path pattern as the other repositories.

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';

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

async function getTables() {
    const { pgConfig } = await import('../../config/database/postgres.js');
    return pgConfig.tables;
}

function mapRow(row) {
    if (!row) return null;
    return {
        channelId: row.channel_id,
        guildId: row.guild_id,
        emojis: Array.isArray(row.emojis) ? row.emojis : [],
    };
}

function degradedKey(channelId) {
    return `autoreact_rule:${channelId}`;
}

export async function getRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.autoreact_channel_rules} WHERE channel_id = $1`,
                [channelId],
            );
            return mapRow(result.rows[0]);
        }

        const record = await getFromDb(degradedKey(channelId), null);
        return record ? mapRow({
            channel_id: record.channelId,
            guild_id: record.guildId,
            emojis: record.emojis,
        }) : null;
    } catch (error) {
        logger.error(`Error fetching autoreact rule for channel ${channelId}:`, error);
        throw error;
    }
}

export async function getAllRules() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.autoreact_channel_rules}`);
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list('autoreact_rule:');
        const rules = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) {
                rules.push(mapRow({
                    channel_id: record.channelId,
                    guild_id: record.guildId,
                    emojis: record.emojis,
                }));
            }
        }
        return rules;
    } catch (error) {
        logger.error('Error loading all autoreact rules:', error);
        return [];
    }
}

export async function listRulesForGuild(guildId) {
    const all = await getAllRules();
    return all.filter((rule) => rule.guildId === guildId);
}

/** Overwrites the emoji list for a channel (creates the row if it doesn't exist). */
export async function setEmojis(guildId, channelId, emojis) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.autoreact_channel_rules} (channel_id, guild_id, emojis)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (channel_id) DO UPDATE SET
                     emojis = EXCLUDED.emojis,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [channelId, guildId, JSON.stringify(emojis)],
            );
            return mapRow(result.rows[0]);
        }

        const record = { channelId, guildId, emojis };
        await db.set(degradedKey(channelId), record);
        return mapRow({ channel_id: channelId, guild_id: guildId, emojis });
    } catch (error) {
        logger.error(`Error setting autoreact emojis for channel ${channelId}:`, error);
        throw error;
    }
}

export async function deleteRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.autoreact_channel_rules} WHERE channel_id = $1 RETURNING channel_id`,
                [channelId],
            );
            return result.rows.length > 0;
        }

        const key = degradedKey(channelId);
        const existing = await getFromDb(key, null);
        if (!existing) return false;
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting autoreact rule for channel ${channelId}:`, error);
        throw error;
    }
}
