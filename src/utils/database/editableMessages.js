// editableMessages.js
//
// Repository layer for the "Editable Messages" feature (/say editable:true).
//
// Same dual-path pattern used by stickyMessages.js: direct SQL against the
// dedicated editable_messages table when PostgreSQL is reachable, in-memory
// KV fallback when it's degraded. This is the only file that talks SQL for
// this feature.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getEditableMessageKey } from './keys.js';

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

function parseAllowedRoles(rawValue) {
    if (Array.isArray(rawValue)) return rawValue;
    if (!rawValue) return [];
    try {
        const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function mapRow(row) {
    if (!row) return null;
    return {
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        creatorId: row.creator_id,
        allowedRoles: parseAllowedRoles(row.allowed_roles),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Register a bot message as editable by the given roles. Overwrites any
 * previous registration for the same message id (there is only ever one
 * editable-message row per message).
 */
export async function createEditableMessage({
    messageId,
    guildId,
    channelId,
    creatorId,
    allowedRoles = [],
}) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();

            // editable_messages has a guild_id FK — make sure the parent row exists.
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at)
                 VALUES ($1, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );

            const result = await db.db.pool.query(
                `INSERT INTO ${tables.editable_messages}
                    (message_id, guild_id, channel_id, creator_id, allowed_roles)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (message_id) DO UPDATE SET
                     guild_id = EXCLUDED.guild_id,
                     channel_id = EXCLUDED.channel_id,
                     creator_id = EXCLUDED.creator_id,
                     allowed_roles = EXCLUDED.allowed_roles,
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [messageId, guildId, channelId, creatorId, JSON.stringify(allowedRoles)],
            );
            return mapRow(result.rows[0]);
        }

        const record = {
            messageId,
            guildId,
            channelId,
            creatorId,
            allowedRoles,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await db.set(getEditableMessageKey(messageId), record);
        return mapRow({
            message_id: record.messageId,
            guild_id: record.guildId,
            channel_id: record.channelId,
            creator_id: record.creatorId,
            allowed_roles: record.allowedRoles,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        });
    } catch (error) {
        logger.error(`Error creating editable message ${messageId}:`, error);
        throw error;
    }
}

/** Fetch the editable-message registration for a message id, or null. */
export async function getEditableMessage(messageId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `SELECT * FROM ${tables.editable_messages} WHERE message_id = $1`,
                [messageId],
            );
            return mapRow(result.rows[0]);
        }

        const record = await getFromDb(getEditableMessageKey(messageId), null);
        if (!record) return null;
        return mapRow({
            message_id: record.messageId,
            guild_id: record.guildId,
            channel_id: record.channelId,
            creator_id: record.creatorId,
            allowed_roles: record.allowedRoles,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        });
    } catch (error) {
        logger.error(`Error fetching editable message ${messageId}:`, error);
        throw error;
    }
}

/** Permanently remove an editable-message registration (e.g. if the message was deleted). */
export async function deleteEditableMessage(messageId) {
    await ensureInitialized();

    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `DELETE FROM ${tables.editable_messages} WHERE message_id = $1`,
                [messageId],
            );
            return;
        }

        await db.delete(getEditableMessageKey(messageId));
    } catch (error) {
        logger.error(`Error deleting editable message ${messageId}:`, error);
        throw error;
    }
}

/**
 * Whether a guild member is allowed to edit a given editable message:
 * server Administrators always can; otherwise the member must hold at
 * least one of the roles selected when the message was created.
 */
export async function canEditMessage(messageId, member) {
    const data = await getEditableMessage(messageId);
    if (!data) return false;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }

    if (data.allowedRoles.length === 0) {
        return false;
    }

    return member.roles.cache.some((role) => data.allowedRoles.includes(role.id));
}
