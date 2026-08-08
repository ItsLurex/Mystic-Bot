// altDetect.js
//
// Repository for the Alt Detector feature. Two tables:
//   - alt_detect_config: one row per guild (threshold, action, alert channel,
//     DM toggle, exempt roles).
//   - alt_detect_flags: one row per (guild, user) that has been flagged as a
//     suspected alt account — tracks how it was detected (join/scan/manual),
//     what happened to it (flagged/alerted/kicked/banned/cleared), and when.
//
// Same dual-path pattern as the other repositories: SQL when PostgreSQL is
// available, key-value fallback otherwise.

import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';

export const ALT_DETECT_ACTIONS = ['alert', 'kick', 'ban'];
export const ALT_DETECT_FLAG_SOURCES = ['join', 'scan', 'manual'];
export const ALT_DETECT_FLAG_STATUSES = ['flagged', 'alerted', 'kicked', 'banned', 'cleared'];

const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 7;
const DEFAULT_ACTION = 'alert';

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
// alt_detect_config
// ---------------------------------------------------------------------------

/** The config a guild gets before it has ever touched the feature. */
export function defaultConfig(guildId) {
    return {
        guildId,
        enabled: false,
        minAccountAgeDays: DEFAULT_MIN_ACCOUNT_AGE_DAYS,
        action: DEFAULT_ACTION,
        alertChannelId: null,
        dmUser: true,
        exemptRoleIds: [],
    };
}

function mapConfigRow(row) {
    if (!row) return null;
    return {
        guildId: row.guild_id,
        enabled: Boolean(row.enabled),
        minAccountAgeDays: Number(row.min_account_age_days) || DEFAULT_MIN_ACCOUNT_AGE_DAYS,
        action: ALT_DETECT_ACTIONS.includes(row.action) ? row.action : DEFAULT_ACTION,
        alertChannelId: row.alert_channel_id || null,
        dmUser: row.dm_user !== false,
        exemptRoleIds: Array.isArray(row.exempt_role_ids) ? row.exempt_role_ids : [],
    };
}

function degradedConfigKey(guildId) {
    return `alt_detect_config:${guildId}`;
}

function degradedConfigToRow(record) {
    return {
        guild_id: record.guildId,
        enabled: record.enabled,
        min_account_age_days: record.minAccountAgeDays,
        action: record.action,
        alert_channel_id: record.alertChannelId,
        dm_user: record.dmUser,
        exempt_role_ids: record.exemptRoleIds,
    };
}

export async function getConfig(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.alt_detect_config} WHERE guild_id = $1`,
                [guildId],
            );
            return mapConfigRow(result.rows[0]) || defaultConfig(guildId);
        }

        const record = await getFromDb(degradedConfigKey(guildId), null);
        return record ? mapConfigRow(degradedConfigToRow(record)) : defaultConfig(guildId);
    } catch (error) {
        logger.error(`Error fetching alt-detect config for guild ${guildId}:`, error);
        throw error;
    }
}

export async function getAllConfigs() {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.alt_detect_config}`);
            return result.rows.map(mapConfigRow);
        }

        if (typeof db.list !== 'function') return [];
        const keys = await db.list('alt_detect_config:');
        const configs = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) configs.push(mapConfigRow(degradedConfigToRow(record)));
        }
        return configs;
    } catch (error) {
        logger.error('Error loading all alt-detect configs:', error);
        return [];
    }
}

/** Creates or replaces the alt-detect config for a guild. */
export async function saveConfig(config) {
    await ensureInitialized();

    const normalized = {
        ...defaultConfig(config.guildId),
        ...config,
        action: ALT_DETECT_ACTIONS.includes(config.action) ? config.action : DEFAULT_ACTION,
        exemptRoleIds: Array.isArray(config.exemptRoleIds) ? config.exemptRoleIds : [],
    };

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [normalized.guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.alt_detect_config}
                     (guild_id, enabled, min_account_age_days, action, alert_channel_id, dm_user, exempt_role_ids)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (guild_id) DO UPDATE SET
                     enabled = EXCLUDED.enabled,
                     min_account_age_days = EXCLUDED.min_account_age_days,
                     action = EXCLUDED.action,
                     alert_channel_id = EXCLUDED.alert_channel_id,
                     dm_user = EXCLUDED.dm_user,
                     exempt_role_ids = EXCLUDED.exempt_role_ids,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [
                    normalized.guildId,
                    normalized.enabled,
                    normalized.minAccountAgeDays,
                    normalized.action,
                    normalized.alertChannelId,
                    normalized.dmUser,
                    JSON.stringify(normalized.exemptRoleIds),
                ],
            );
            return mapConfigRow(result.rows[0]);
        }

        await db.set(degradedConfigKey(normalized.guildId), normalized);
        return mapConfigRow(degradedConfigToRow(normalized));
    } catch (error) {
        logger.error(`Error saving alt-detect config for guild ${normalized.guildId}:`, error);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// alt_detect_flags
// ---------------------------------------------------------------------------

function mapFlagRow(row) {
    if (!row) return null;
    return {
        guildId: row.guild_id,
        userId: row.user_id,
        userTag: row.user_tag || null,
        accountCreatedAt: row.account_created_at ? new Date(row.account_created_at) : null,
        accountAgeDays: row.account_age_days == null ? null : Number(row.account_age_days),
        source: row.source,
        status: row.status,
        notes: row.notes || null,
        flaggedAt: row.flagged_at ? new Date(row.flagged_at) : null,
        resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    };
}

function degradedFlagKey(guildId, userId) {
    return `alt_detect_flag:${guildId}:${userId}`;
}

function degradedFlagToListKey(guildId) {
    return `alt_detect_flags_list:${guildId}`;
}

function degradedFlagToRow(record) {
    return {
        guild_id: record.guildId,
        user_id: record.userId,
        user_tag: record.userTag,
        account_created_at: record.accountCreatedAt,
        account_age_days: record.accountAgeDays,
        source: record.source,
        status: record.status,
        notes: record.notes,
        flagged_at: record.flaggedAt,
        resolved_at: record.resolvedAt,
    };
}

/**
 * Creates or updates the flag for a user. Existing flags keep their original
 * source/flagged_at unless explicitly overridden; status and notes always
 * refresh, and resolved_at is stamped for terminal statuses.
 */
export async function upsertFlag({
    guildId,
    userId,
    userTag = null,
    accountCreatedAt = null,
    accountAgeDays = null,
    source = 'join',
    status = 'flagged',
    notes = null,
}) {
    await ensureInitialized();

    const resolvedAt = ['kicked', 'banned', 'cleared'].includes(status) ? new Date() : null;

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.alt_detect_flags}
                     (guild_id, user_id, user_tag, account_created_at, account_age_days, source, status, notes, flagged_at, resolved_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9)
                 ON CONFLICT (guild_id, user_id) DO UPDATE SET
                     user_tag = COALESCE(EXCLUDED.user_tag, ${tables.alt_detect_flags}.user_tag),
                     account_created_at = COALESCE(EXCLUDED.account_created_at, ${tables.alt_detect_flags}.account_created_at),
                     account_age_days = COALESCE(EXCLUDED.account_age_days, ${tables.alt_detect_flags}.account_age_days),
                     status = EXCLUDED.status,
                     notes = COALESCE(EXCLUDED.notes, ${tables.alt_detect_flags}.notes),
                     resolved_at = EXCLUDED.resolved_at,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [guildId, userId, userTag, accountCreatedAt, accountAgeDays, source, status, notes, resolvedAt],
            );
            return mapFlagRow(result.rows[0]);
        }

        const existing = await getFromDb(degradedFlagKey(guildId, userId), null);
        const resolvedCreatedAt = accountCreatedAt
            ?? (existing?.accountCreatedAt ? new Date(existing.accountCreatedAt) : null);
        const record = {
            guildId,
            userId,
            userTag: userTag ?? existing?.userTag ?? null,
            accountCreatedAt: resolvedCreatedAt ? resolvedCreatedAt.toISOString() : null,
            accountAgeDays: accountAgeDays ?? existing?.accountAgeDays ?? null,
            source: existing?.source || source,
            status,
            notes: notes ?? existing?.notes ?? null,
            flaggedAt: existing?.flaggedAt || new Date().toISOString(),
            resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
        };
        await db.set(degradedFlagKey(guildId, userId), record);

        const listKey = degradedFlagToListKey(guildId);
        const list = (await getFromDb(listKey, null)) || [];
        if (!list.includes(userId)) {
            list.push(userId);
            await db.set(listKey, list);
        }
        return mapFlagRow(degradedFlagToRow(record));
    } catch (error) {
        logger.error(`Error upserting alt-detect flag for ${userId} in guild ${guildId}:`, error);
        throw error;
    }
}

export async function getFlag(guildId, userId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.alt_detect_flags} WHERE guild_id = $1 AND user_id = $2`,
                [guildId, userId],
            );
            return mapFlagRow(result.rows[0]);
        }

        const record = await getFromDb(degradedFlagKey(guildId, userId), null);
        return record ? mapFlagRow(degradedFlagToRow(record)) : null;
    } catch (error) {
        logger.error(`Error fetching alt-detect flag for ${userId} in guild ${guildId}:`, error);
        return null;
    }
}

export async function listFlags(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.alt_detect_flags} WHERE guild_id = $1 ORDER BY flagged_at DESC`,
                [guildId],
            );
            return result.rows.map(mapFlagRow);
        }

        const listKey = degradedFlagToListKey(guildId);
        const userIds = (await getFromDb(listKey, null)) || [];
        const flags = [];
        for (const userId of userIds) {
            const record = await getFromDb(degradedFlagKey(guildId, userId), null);
            if (record) flags.push(mapFlagRow(degradedFlagToRow(record)));
        }
        flags.sort((a, b) => (b.flaggedAt?.getTime() || 0) - (a.flaggedAt?.getTime() || 0));
        return flags;
    } catch (error) {
        logger.error(`Error listing alt-detect flags for guild ${guildId}:`, error);
        return [];
    }
}

/** Removes a flag entirely (used by `/altdetect unflag`). Returns true if one existed. */
export async function removeFlag(guildId, userId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `DELETE FROM ${tables.alt_detect_flags} WHERE guild_id = $1 AND user_id = $2 RETURNING user_id`,
                [guildId, userId],
            );
            return result.rows.length > 0;
        }

        const key = degradedFlagKey(guildId, userId);
        const existing = await getFromDb(key, null);
        if (!existing) return false;
        await db.delete(key);

        const listKey = degradedFlagToListKey(guildId);
        const list = (await getFromDb(listKey, null)) || [];
        const index = list.indexOf(userId);
        if (index !== -1) {
            list.splice(index, 1);
            await db.set(listKey, list);
        }
        return true;
    } catch (error) {
        logger.error(`Error removing alt-detect flag for ${userId} in guild ${guildId}:`, error);
        return false;
    }
}
