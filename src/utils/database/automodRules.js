// automodRules.js
//
// Repository for per-channel Auto-Moderation rules. Same dual-path pattern
// as stickyMessages.js: direct SQL against automod_channel_rules when
// Postgres is reachable, in-memory KV fallback when degraded.

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getAutomodRuleKey, getAutomodRulePrefix } from './keys.js';

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
        ruleType: row.rule_type,
        config: row.config || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export async function getRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.automod_channel_rules} WHERE channel_id = $1`,
                [channelId],
            );
            return mapRow(result.rows[0]);
        }

        const record = await getFromDb(getAutomodRuleKey(channelId), null);
        return record ? mapRow({
            channel_id: record.channelId,
            guild_id: record.guildId,
            rule_type: record.ruleType,
            config: record.config,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        }) : null;
    } catch (error) {
        logger.error(`Error fetching automod rule for channel ${channelId}:`, error);
        throw error;
    }
}

export async function listRulesForGuild(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.automod_channel_rules} WHERE guild_id = $1 ORDER BY created_at ASC`,
                [guildId],
            );
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list(getAutomodRulePrefix());
        const rules = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record && record.guildId === guildId) {
                rules.push(mapRow({
                    channel_id: record.channelId,
                    guild_id: record.guildId,
                    rule_type: record.ruleType,
                    config: record.config,
                    created_at: record.createdAt,
                    updated_at: record.updatedAt,
                }));
            }
        }
        return rules;
    } catch (error) {
        logger.error(`Error listing automod rules for guild ${guildId}:`, error);
        throw error;
    }
}

export async function getAllRules() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.automod_channel_rules}`);
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list(getAutomodRulePrefix());
        const rules = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) {
                rules.push(mapRow({
                    channel_id: record.channelId,
                    guild_id: record.guildId,
                    rule_type: record.ruleType,
                    config: record.config,
                    created_at: record.createdAt,
                    updated_at: record.updatedAt,
                }));
            }
        }
        return rules;
    } catch (error) {
        logger.error('Error loading all automod rules:', error);
        return [];
    }
}

/** Creates or replaces the rule for a channel (one rule per channel). */
export async function setRule({ guildId, channelId, ruleType, config = {} }) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.automod_channel_rules} (channel_id, guild_id, rule_type, config)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (channel_id) DO UPDATE SET
                     rule_type = EXCLUDED.rule_type,
                     config = EXCLUDED.config,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [channelId, guildId, ruleType, JSON.stringify(config)],
            );
            return mapRow(result.rows[0]);
        }

        const record = {
            channelId,
            guildId,
            ruleType,
            config,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await db.set(getAutomodRuleKey(channelId), record);
        return mapRow({
            channel_id: channelId,
            guild_id: guildId,
            rule_type: ruleType,
            config,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        });
    } catch (error) {
        logger.error(`Error setting automod rule for channel ${channelId}:`, error);
        throw error;
    }
}

export async function deleteRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.automod_channel_rules} WHERE channel_id = $1 RETURNING channel_id`,
                [channelId],
            );
            return result.rows.length > 0;
        }

        const key = getAutomodRuleKey(channelId);
        const existing = await getFromDb(key, null);
        if (!existing) return false;
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting automod rule for channel ${channelId}:`, error);
        throw error;
    }
}
