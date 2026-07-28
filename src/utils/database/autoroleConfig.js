// autoroleConfig.js
//
// Repository for the per-guild Auto-Role config: which role to give humans
// on join, and which role to give bots on join. One row per guild. Same
// dual-path pattern as the other repositories.

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getAutoroleConfigKey } from './keys.js';

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
        guildId: row.guild_id,
        memberRoleId: row.member_role_id,
        botRoleId: row.bot_role_id,
    };
}

export async function getAutoroleConfig(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.autorole_config} WHERE guild_id = $1`,
                [guildId],
            );
            return mapRow(result.rows[0]);
        }

        const record = await getFromDb(getAutoroleConfigKey(guildId), null);
        return record ? mapRow({
            guild_id: guildId,
            member_role_id: record.memberRoleId,
            bot_role_id: record.botRoleId,
        }) : null;
    } catch (error) {
        logger.error(`Error fetching autorole config for guild ${guildId}:`, error);
        return null;
    }
}

/** Fetches every guild's autorole config (used to warm the cache at startup). */
export async function getAllAutoroleConfigs() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.autorole_config}`);
            return result.rows.map(mapRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list('guild:');
        const configs = [];
        for (const key of keys) {
            if (!key.endsWith(':autorole_config')) continue;
            const record = await getFromDb(key, null);
            const guildId = key.split(':')[1];
            if (record) {
                configs.push(mapRow({
                    guild_id: guildId,
                    member_role_id: record.memberRoleId,
                    bot_role_id: record.botRoleId,
                }));
            }
        }
        return configs;
    } catch (error) {
        logger.error('Error loading all autorole configs:', error);
        return [];
    }
}

/** Partially updates a guild's autorole config (creates the row if needed). */
export async function setAutoroleConfig(guildId, { memberRoleId, botRoleId } = {}) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );

            const existing = await getAutoroleConfig(guildId);
            const nextMemberRoleId = memberRoleId !== undefined ? memberRoleId : existing?.memberRoleId ?? null;
            const nextBotRoleId = botRoleId !== undefined ? botRoleId : existing?.botRoleId ?? null;

            const result = await db.db.pool.query(
                `INSERT INTO ${tables.autorole_config} (guild_id, member_role_id, bot_role_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (guild_id) DO UPDATE SET
                     member_role_id = EXCLUDED.member_role_id,
                     bot_role_id = EXCLUDED.bot_role_id,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [guildId, nextMemberRoleId, nextBotRoleId],
            );
            return mapRow(result.rows[0]);
        }

        const key = getAutoroleConfigKey(guildId);
        const existing = (await getFromDb(key, null)) || {};
        const record = {
            memberRoleId: memberRoleId !== undefined ? memberRoleId : existing.memberRoleId ?? null,
            botRoleId: botRoleId !== undefined ? botRoleId : existing.botRoleId ?? null,
        };
        await db.set(key, record);
        return mapRow({ guild_id: guildId, member_role_id: record.memberRoleId, bot_role_id: record.botRoleId });
    } catch (error) {
        logger.error(`Error setting autorole config for guild ${guildId}:`, error);
        throw error;
    }
}
