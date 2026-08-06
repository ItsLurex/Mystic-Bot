// approvedAdminRoles.js
//
// Repository for roles you've explicitly approved as OK to have
// Administrator — the Server Health Scanner skips flagging these.

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

function degradedKey(guildId) {
    return `guild:${guildId}:approved_admin_roles`;
}

export async function getApprovedRoles(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT role_id FROM ${tables.approved_admin_roles} WHERE guild_id = $1`,
                [guildId],
            );
            return result.rows.map((row) => row.role_id);
        }

        const record = await getFromDb(degradedKey(guildId), null);
        return Array.isArray(record) ? record : [];
    } catch (error) {
        logger.error(`Error fetching approved admin roles for guild ${guildId}:`, error);
        return [];
    }
}

export async function addApprovedRole(guildId, roleId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            await db.db.pool.query(
                `INSERT INTO ${tables.approved_admin_roles} (guild_id, role_id) VALUES ($1, $2) ON CONFLICT (guild_id, role_id) DO NOTHING`,
                [guildId, roleId],
            );
            return;
        }

        const key = degradedKey(guildId);
        const roles = (await getFromDb(key, null)) || [];
        const list = Array.isArray(roles) ? roles : [];
        if (!list.includes(roleId)) {
            list.push(roleId);
            await db.set(key, list);
        }
    } catch (error) {
        logger.error(`Error approving admin role ${roleId} for guild ${guildId}:`, error);
        throw error;
    }
}

export async function removeApprovedRole(guildId, roleId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.approved_admin_roles} WHERE guild_id = $1 AND role_id = $2 RETURNING role_id`,
                [guildId, roleId],
            );
            return result.rows.length > 0;
        }

        const key = degradedKey(guildId);
        const roles = (await getFromDb(key, null)) || [];
        const list = Array.isArray(roles) ? roles : [];
        const next = list.filter((id) => id !== roleId);
        const changed = next.length !== list.length;
        if (changed) await db.set(key, next);
        return changed;
    } catch (error) {
        logger.error(`Error unapproving admin role ${roleId} for guild ${guildId}:`, error);
        throw error;
    }
}
