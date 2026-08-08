/**
 * Web sessions persistence for dashboard auth.
 * Stores session id -> user data with expiry.
 */

import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../logger.js';

function getTables() {
    return pgConfig.tables;
}

function getDb(client) {
    return client?.db?.db || client?.db || null;
}

export async function saveWebSession(client, sessionId, userId, data, expiresAt) {
    try {
        const db = getDb(client);
        const tables = getTables();
        if (!db || !db.pool) {
            // Fallback to in-memory via wrapper
            if (client?.db?.set) {
                await client.db.set(`web_session:${sessionId}`, { userId, data, expiresAt: expiresAt?.toISOString?.() || null });
            }
            return true;
        }

        await db.pool.query(
            `INSERT INTO ${tables.web_sessions} (id, user_id, data, expires_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, NOW())
             ON CONFLICT (id) DO UPDATE SET
               user_id = EXCLUDED.user_id,
               data = EXCLUDED.data,
               expires_at = EXCLUDED.expires_at,
               updated_at = NOW()`,
            [sessionId, userId, JSON.stringify(data || {}), expiresAt]
        );
        return true;
    } catch (error) {
        logger.error('Error saving web session:', error);
        return false;
    }
}

export async function getWebSession(client, sessionId) {
    try {
        const db = getDb(client);
        const tables = getTables();
        if (!db || !db.pool) {
            if (client?.db?.get) {
                const data = await client.db.get(`web_session:${sessionId}`);
                if (!data) return null;
                if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
                    await client.db.delete?.(`web_session:${sessionId}`);
                    return null;
                }
                return data;
            }
            return null;
        }

        const result = await db.pool.query(
            `SELECT * FROM ${tables.web_sessions} WHERE id = $1`,
            [sessionId]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
            await deleteWebSession(client, sessionId);
            return null;
        }
        return {
            id: row.id,
            userId: row.user_id,
            data: row.data,
            expiresAt: row.expires_at,
        };
    } catch (error) {
        logger.error('Error getting web session:', error);
        return null;
    }
}

export async function deleteWebSession(client, sessionId) {
    try {
        const db = getDb(client);
        const tables = getTables();
        if (!db || !db.pool) {
            if (client?.db?.delete) {
                await client.db.delete(`web_session:${sessionId}`);
            }
            return true;
        }
        await db.pool.query(`DELETE FROM ${tables.web_sessions} WHERE id = $1`, [sessionId]);
        return true;
    } catch (error) {
        logger.error('Error deleting web session:', error);
        return false;
    }
}

export async function cleanupExpiredSessions(client) {
    try {
        const db = getDb(client);
        const tables = getTables();
        if (!db || !db.pool) return;
        await db.pool.query(`DELETE FROM ${tables.web_sessions} WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
    } catch (error) {
        logger.debug('Error cleaning expired web sessions:', error.message);
    }
}
