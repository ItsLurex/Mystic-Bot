/**
 * Guild logs persistence for web dashboard.
 * Stores moderation / audit events to be viewed via web.
 */

import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../logger.js';

function getTables() {
    return pgConfig.tables;
}

function getDb(client) {
    return client?.db?.db || client?.db || null;
}

export async function saveGuildLog(client, { guildId, eventType, userId = null, moderatorId = null, channelId = null, data = {} }) {
    try {
        if (!guildId || !eventType) return false;
        const db = getDb(client);
        const tables = getTables();

        if (!db || !db.pool) {
            // Fallback to in-memory circular buffer per guild (last 500)
            if (client?.db?.get && client?.db?.set) {
                const key = `guild_logs:${guildId}`;
                const existing = (await client.db.get(key, [])) || [];
                existing.unshift({
                    guild_id: guildId,
                    event_type: eventType,
                    user_id: userId,
                    moderator_id: moderatorId,
                    channel_id: channelId,
                    data,
                    created_at: new Date().toISOString(),
                });
                if (existing.length > 500) existing.splice(500);
                await client.db.set(key, existing);
            }
            return true;
        }

        await db.pool.query(
            `INSERT INTO ${tables.guild_logs} (guild_id, event_type, user_id, moderator_id, channel_id, data)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [guildId, eventType, userId, moderatorId, channelId, JSON.stringify(data || {})]
        );
        return true;
    } catch (error) {
        logger.debug('Error saving guild log:', error.message);
        return false;
    }
}

export async function getGuildLogs(client, guildId, { limit = 100, offset = 0, eventType = null, userId = null } = {}) {
    try {
        if (!guildId) return [];
        const db = getDb(client);
        const tables = getTables();
        const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
        const safeOffset = Math.max(parseInt(offset) || 0, 0);

        if (!db || !db.pool) {
            if (client?.db?.get) {
                const key = `guild_logs:${guildId}`;
                let logs = (await client.db.get(key, [])) || [];
                if (eventType) logs = logs.filter(l => l.event_type === eventType || l.eventType === eventType);
                if (userId) logs = logs.filter(l => l.user_id === userId || l.userId === userId);
                return logs.slice(safeOffset, safeOffset + safeLimit).map((l, idx) => ({
                    id: idx,
                    guild_id: l.guild_id || guildId,
                    event_type: l.event_type || l.eventType,
                    user_id: l.user_id || l.userId,
                    moderator_id: l.moderator_id || l.moderatorId,
                    channel_id: l.channel_id || l.channelId,
                    data: l.data || {},
                    created_at: l.created_at,
                }));
            }
            return [];
        }

        let query = `SELECT * FROM ${tables.guild_logs} WHERE guild_id = $1`;
        const params = [guildId];
        let paramIdx = 2;

        if (eventType) {
            query += ` AND event_type = $${paramIdx}`;
            params.push(eventType);
            paramIdx++;
        }
        if (userId) {
            query += ` AND user_id = $${paramIdx}`;
            params.push(userId);
            paramIdx++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(safeLimit, safeOffset);

        const result = await db.pool.query(query, params);
        return result.rows;
    } catch (error) {
        logger.error('Error getting guild logs:', error);
        return [];
    }
}

export async function getGuildLogStats(client, guildId) {
    try {
        if (!guildId) return { total: 0, byType: {} };
        const logs = await getGuildLogs(client, guildId, { limit: 1000 });
        const byType = {};
        for (const log of logs) {
            const type = log.event_type;
            byType[type] = (byType[type] || 0) + 1;
        }
        return { total: logs.length, byType };
    } catch {
        return { total: 0, byType: {} };
    }
}

export async function clearGuildLogs(client, guildId, olderThanDays = null) {
    try {
        const db = getDb(client);
        const tables = getTables();
        if (!db || !db.pool) {
            if (client?.db?.delete) {
                await client.db.delete(`guild_logs:${guildId}`);
            }
            return true;
        }

        if (olderThanDays) {
            await db.pool.query(
                `DELETE FROM ${tables.guild_logs} WHERE guild_id = $1 AND created_at < NOW() - INTERVAL '${parseInt(olderThanDays)} days'`,
                [guildId]
            );
        } else {
            await db.pool.query(`DELETE FROM ${tables.guild_logs} WHERE guild_id = $1`, [guildId]);
        }
        return true;
    } catch (error) {
        logger.error('Error clearing guild logs:', error);
        return false;
    }
}
