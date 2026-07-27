// ignoredRoles.js
//
// Repository for the shared "ignored roles" list — staff/owner roles that
// bypass Auto-Moderation and are excluded from invite tracking. One guild-
// wide list, reused by both features. Same dual-path pattern as the other
// repositories: direct SQL when Postgres is reachable, in-memory KV
// fallback when degraded.

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getIgnoredRolesKey } from './keys.js';

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

/** Returns the full list of ignored role ids for a guild. */
export async function getIgnoredRoles(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT role_id FROM ${tables.ignored_roles} WHERE guild_id = $1`,
                [guildId],
            );
            return result.rows.map((row) => row.role_id);
        }

        const record = await getFromDb(getIgnoredRolesKey(guildId), null);
        return Array.isArray(record) ? record : [];
    } catch (error) {
        logger.error(`Error fetching ignored roles for guild ${guildId}:`, error);
        return [];
    }
}

export async function addIgnoredRole(guildId, roleId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            await db.db.pool.query(
                `INSERT INTO ${tables.ignored_roles} (guild_id, role_id) VALUES ($1, $2) ON CONFLICT (guild_id, role_id) DO NOTHING`,
                [guildId, roleId],
            );
            return true;
        }

        const key = getIgnoredRolesKey(guildId);
        const record = (await getFromDb(key, null)) || [];
        const roles = Array.isArray(record) ? record : [];
        if (!roles.includes(roleId)) {
            roles.push(roleId);
            await db.set(key, roles);
        }
        return true;
    } catch (error) {
        logger.error(`Error adding ignored role ${roleId} for guild ${guildId}:`, error);
        throw error;
    }
}

export async function removeIgnoredRole(guildId, roleId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.ignored_roles} WHERE guild_id = $1 AND role_id = $2 RETURNING role_id`,
                [guildId, roleId],
            );
            return result.rows.length > 0;
        }

        const key = getIgnoredRolesKey(guildId);
        const record = (await getFromDb(key, null)) || [];
        const roles = Array.isArray(record) ? record : [];
        const nextRoles = roles.filter((id) => id !== roleId);
        const changed = nextRoles.length !== roles.length;
        if (changed) {
            await db.set(key, nextRoles);
        }
        return changed;
    } catch (error) {
        logger.error(`Error removing ignored role ${roleId} for guild ${guildId}:`, error);
        throw error;
    }
}
