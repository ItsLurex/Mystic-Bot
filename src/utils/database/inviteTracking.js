// inviteTracking.js
//
// Repository for the Invite Tracker feature. Two tables:
//   - invite_tracking: one row per invite code (guild_id, code, inviter,
//     last-known use count). Used to diff against a fresh fetch and figure
//     out which invite was just used.
//   - invite_join_records: one row per join event (who joined, credited to
//     which inviter, real/fake/left status). This is what /invites stats
//     are actually computed from.
//
// Same dual-path pattern as the other repositories: direct SQL when
// Postgres is reachable, in-memory KV fallback when degraded.

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
// invite_tracking (per invite-code cache)
// ---------------------------------------------------------------------------

/** Fetches every known invite code + use-count for a guild (used to warm the diffing cache). */
export async function getInviteCodesForGuild(guildId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT invite_code, inviter_id, uses FROM ${tables.invite_tracking} WHERE guild_id = $1`,
                [guildId],
            );
            return result.rows.map((row) => ({
                code: row.invite_code,
                inviterId: row.inviter_id,
                uses: row.uses,
            }));
        }

        const record = await getFromDb(`guild:${guildId}:invite_codes`, null);
        return Array.isArray(record) ? record : [];
    } catch (error) {
        logger.error(`Error fetching invite codes for guild ${guildId}:`, error);
        return [];
    }
}

/** Creates or updates the cached record for a single invite code. */
export async function upsertInviteCode({ guildId, code, inviterId, uses }) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            await db.db.pool.query(
                `INSERT INTO ${tables.invite_tracking} (guild_id, invite_code, inviter_id, uses)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (guild_id, invite_code) DO UPDATE SET
                     inviter_id = EXCLUDED.inviter_id,
                     uses = EXCLUDED.uses,
                     updated_at = CURRENT_TIMESTAMP`,
                [guildId, code, inviterId, uses],
            );
            return;
        }

        const key = `guild:${guildId}:invite_codes`;
        const codes = (await getFromDb(key, null)) || [];
        const list = Array.isArray(codes) ? codes : [];
        const index = list.findIndex((entry) => entry.code === code);
        const entry = { code, inviterId, uses };
        if (index >= 0) {
            list[index] = entry;
        } else {
            list.push(entry);
        }
        await db.set(key, list);
    } catch (error) {
        logger.error(`Error upserting invite code ${code} for guild ${guildId}:`, error);
    }
}

/** Removes a deleted invite code from the cache. */
export async function deleteInviteCode(guildId, code) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `DELETE FROM ${tables.invite_tracking} WHERE guild_id = $1 AND invite_code = $2`,
                [guildId, code],
            );
            return;
        }

        const key = `guild:${guildId}:invite_codes`;
        const codes = (await getFromDb(key, null)) || [];
        const list = Array.isArray(codes) ? codes : [];
        await db.set(key, list.filter((entry) => entry.code !== code));
    } catch (error) {
        logger.error(`Error deleting invite code ${code} for guild ${guildId}:`, error);
    }
}

// ---------------------------------------------------------------------------
// invite_join_records (per-join history, what stats are computed from)
// ---------------------------------------------------------------------------

/** Records a join event. */
export async function createJoinRecord({ guildId, joinedUserId, inviterId, inviteCode, status }) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.invite_join_records} (guild_id, joined_user_id, inviter_id, invite_code, status)
                 VALUES ($1, $2, $3, $4, $5)`,
                [guildId, joinedUserId, inviterId, inviteCode, status],
            );
            return;
        }

        const key = `guild:${guildId}:invite_joins`;
        const records = (await getFromDb(key, null)) || [];
        const list = Array.isArray(records) ? records : [];
        list.push({
            guildId,
            joinedUserId,
            inviterId,
            inviteCode,
            status,
            joinedAt: new Date().toISOString(),
            leftAt: null,
        });
        await db.set(key, list);
    } catch (error) {
        logger.error(`Error creating invite join record for ${joinedUserId} in guild ${guildId}:`, error);
    }
}

/**
 * Marks the most recent still-"real" join record for a user as "left"
 * (called from guildMemberRemove). No-op if they were never tracked as a
 * real invite (e.g. already flagged fake, or joined before tracking existed).
 */
export async function markMostRecentJoinAsLeft(guildId, joinedUserId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `UPDATE ${tables.invite_join_records}
                 SET status = 'left', left_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = (
                     SELECT id FROM ${tables.invite_join_records}
                     WHERE guild_id = $1 AND joined_user_id = $2 AND status = 'real'
                     ORDER BY joined_at DESC
                     LIMIT 1
                 )`,
                [guildId, joinedUserId],
            );
            return;
        }

        const key = `guild:${guildId}:invite_joins`;
        const records = (await getFromDb(key, null)) || [];
        const list = Array.isArray(records) ? records : [];
        const candidates = list
            .filter((r) => r.joinedUserId === joinedUserId && r.status === 'real')
            .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
        if (candidates.length > 0) {
            candidates[0].status = 'left';
            candidates[0].leftAt = new Date().toISOString();
            await db.set(key, list);
        }
    } catch (error) {
        logger.error(`Error marking invite join as left for ${joinedUserId} in guild ${guildId}:`, error);
    }
}

/** Returns real/fake/left counts for everyone a given user has invited. */
export async function getInviteStats(guildId, inviterId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT status, COUNT(*) AS count
                 FROM ${tables.invite_join_records}
                 WHERE guild_id = $1 AND inviter_id = $2
                 GROUP BY status`,
                [guildId, inviterId],
            );
            const stats = { real: 0, fake: 0, left: 0 };
            for (const row of result.rows) {
                if (row.status in stats) stats[row.status] = Number(row.count);
            }
            return stats;
        }

        const key = `guild:${guildId}:invite_joins`;
        const records = (await getFromDb(key, null)) || [];
        const list = Array.isArray(records) ? records : [];
        const stats = { real: 0, fake: 0, left: 0 };
        for (const record of list) {
            if (record.inviterId === inviterId && record.status in stats) {
                stats[record.status] += 1;
            }
        }
        return stats;
    } catch (error) {
        logger.error(`Error fetching invite stats for ${inviterId} in guild ${guildId}:`, error);
        return { real: 0, fake: 0, left: 0 };
    }
}
