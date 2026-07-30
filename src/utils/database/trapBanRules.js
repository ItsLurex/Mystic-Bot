// trapBanRules.js
//
// Repository for the Auto-Ban trap-channel feature. Two tables:
//   - trap_ban_rules: one row per trap channel (ban duration + custom DM).
//   - scheduled_unbans: one row per pending temporary ban, checked by a
//     cron job (see trapBanService.js / app.js) to auto-unban once expired.
//
// Same dual-path pattern as the other repositories.

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

// ---------------------------------------------------------------------------
// trap_ban_rules
// ---------------------------------------------------------------------------

function mapRuleRow(row) {
    if (!row) return null;
    return {
        channelId: row.channel_id,
        guildId: row.guild_id,
        banDurationDays: row.ban_duration_days,
        dmMessage: row.dm_message,
    };
}

function degradedRuleKey(channelId) {
    return `trap_ban_rule:${channelId}`;
}

export async function getRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.trap_ban_rules} WHERE channel_id = $1`,
                [channelId],
            );
            return mapRuleRow(result.rows[0]);
        }

        const record = await getFromDb(degradedRuleKey(channelId), null);
        return record ? mapRuleRow({
            channel_id: record.channelId,
            guild_id: record.guildId,
            ban_duration_days: record.banDurationDays,
            dm_message: record.dmMessage,
        }) : null;
    } catch (error) {
        logger.error(`Error fetching trap-ban rule for channel ${channelId}:`, error);
        throw error;
    }
}

export async function getAllRules() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.trap_ban_rules}`);
            return result.rows.map(mapRuleRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list('trap_ban_rule:');
        const rules = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) {
                rules.push(mapRuleRow({
                    channel_id: record.channelId,
                    guild_id: record.guildId,
                    ban_duration_days: record.banDurationDays,
                    dm_message: record.dmMessage,
                }));
            }
        }
        return rules;
    } catch (error) {
        logger.error('Error loading all trap-ban rules:', error);
        return [];
    }
}

export async function listRulesForGuild(guildId) {
    const all = await getAllRules();
    return all.filter((rule) => rule.guildId === guildId);
}

/** Creates or replaces the rule for a channel (one rule per channel). */
export async function setRule({ guildId, channelId, banDurationDays, dmMessage }) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.trap_ban_rules} (channel_id, guild_id, ban_duration_days, dm_message)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (channel_id) DO UPDATE SET
                     ban_duration_days = EXCLUDED.ban_duration_days,
                     dm_message = EXCLUDED.dm_message,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [channelId, guildId, banDurationDays, dmMessage],
            );
            return mapRuleRow(result.rows[0]);
        }

        const record = { channelId, guildId, banDurationDays, dmMessage };
        await db.set(degradedRuleKey(channelId), record);
        return mapRuleRow({
            channel_id: channelId,
            guild_id: guildId,
            ban_duration_days: banDurationDays,
            dm_message: dmMessage,
        });
    } catch (error) {
        logger.error(`Error setting trap-ban rule for channel ${channelId}:`, error);
        throw error;
    }
}

export async function deleteRule(channelId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.trap_ban_rules} WHERE channel_id = $1 RETURNING channel_id`,
                [channelId],
            );
            return result.rows.length > 0;
        }

        const key = degradedRuleKey(channelId);
        const existing = await getFromDb(key, null);
        if (!existing) return false;
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting trap-ban rule for channel ${channelId}:`, error);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// scheduled_unbans
// ---------------------------------------------------------------------------

function degradedUnbanListKey() {
    return `scheduled_unbans_list`;
}

/** Schedules an automatic unban for a temporary ban. */
export async function scheduleUnban(guildId, userId, unbanAt) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.scheduled_unbans} (guild_id, user_id, unban_at) VALUES ($1, $2, $3)`,
                [guildId, userId, unbanAt],
            );
            return;
        }

        const key = degradedUnbanListKey();
        const list = (await getFromDb(key, null)) || [];
        list.push({ guildId, userId, unbanAt: unbanAt.toISOString() });
        await db.set(key, list);
    } catch (error) {
        logger.error(`Error scheduling unban for ${userId} in guild ${guildId}:`, error);
    }
}

/** Returns every scheduled unban whose time has passed. */
export async function getDueUnbans() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT id, guild_id, user_id FROM ${tables.scheduled_unbans} WHERE unban_at <= CURRENT_TIMESTAMP`,
            );
            return result.rows.map((row) => ({ id: row.id, guildId: row.guild_id, userId: row.user_id }));
        }

        const key = degradedUnbanListKey();
        const list = (await getFromDb(key, null)) || [];
        const now = Date.now();
        return list
            .filter((entry) => new Date(entry.unbanAt).getTime() <= now)
            .map((entry, index) => ({ id: index, guildId: entry.guildId, userId: entry.userId }));
    } catch (error) {
        logger.error('Error fetching due scheduled unbans:', error);
        return [];
    }
}

/** Removes a scheduled unban once it's been carried out (or is no longer needed). */
export async function deleteScheduledUnban(id) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(`DELETE FROM ${tables.scheduled_unbans} WHERE id = $1`, [id]);
            return;
        }

        const key = degradedUnbanListKey();
        const list = (await getFromDb(key, null)) || [];
        list.splice(id, 1);
        await db.set(key, list);
    } catch (error) {
        logger.error(`Error deleting scheduled unban ${id}:`, error);
    }
}
