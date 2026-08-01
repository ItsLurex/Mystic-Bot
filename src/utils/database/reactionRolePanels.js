// reactionRolePanels.js — repository for reaction-role messages.
import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';

function isSqlReady() {
    return Boolean(db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable());
}

async function ensureInitialized() {
    if (!db.initialized) await db.initialize();
}

async function getTables() {
    const { pgConfig } = await import('../../config/database/postgres.js');
    return pgConfig.tables;
}

function mapRow(row) {
    if (!row) return null;
    return {
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        roleMap: row.role_map || {},
    };
}

function degradedKey(messageId) {
    return `reaction_role_panel:${messageId}`;
}

export async function getPanel(messageId) {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.reaction_role_messages} WHERE message_id = $1`, [messageId]);
            return mapRow(result.rows[0]);
        }
        const record = await getFromDb(degradedKey(messageId), null);
        return record ? mapRow({ message_id: messageId, guild_id: record.guildId, channel_id: record.channelId, role_map: record.roleMap }) : null;
    } catch (error) {
        logger.error(`Error fetching reaction role panel ${messageId}:`, error);
        throw error;
    }
}

export async function getAllPanels() {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`SELECT * FROM ${tables.reaction_role_messages}`);
            return result.rows.map(mapRow);
        }
        if (typeof db.list !== 'function') return [];
        const keys = await db.list('reaction_role_panel:');
        const panels = [];
        for (const key of keys) {
            const record = await getFromDb(key, null);
            if (record) {
                const messageId = key.split(':')[1];
                panels.push(mapRow({ message_id: messageId, guild_id: record.guildId, channel_id: record.channelId, role_map: record.roleMap }));
            }
        }
        return panels;
    } catch (error) {
        logger.error('Error loading all reaction role panels:', error);
        return [];
    }
}

export async function createPanel({ guildId, channelId, messageId }) {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            await db.db.pool.query(
                `INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
                [guildId],
            );
            const result = await db.db.pool.query(
                `INSERT INTO ${tables.reaction_role_messages} (message_id, guild_id, channel_id, role_map) VALUES ($1, $2, $3, '{}') RETURNING *`,
                [messageId, guildId, channelId],
            );
            return mapRow(result.rows[0]);
        }
        const record = { guildId, channelId, roleMap: {} };
        await db.set(degradedKey(messageId), record);
        return mapRow({ message_id: messageId, guild_id: guildId, channel_id: channelId, role_map: {} });
    } catch (error) {
        logger.error(`Error creating reaction role panel ${messageId}:`, error);
        throw error;
    }
}

export async function setRoleMapping(messageId, emojiKey, roleId) {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `UPDATE ${tables.reaction_role_messages}
                 SET role_map = role_map || jsonb_build_object($2::text, $3::text), updated_at = CURRENT_TIMESTAMP
                 WHERE message_id = $1 RETURNING *`,
                [messageId, emojiKey, roleId],
            );
            return mapRow(result.rows[0]);
        }
        const key = degradedKey(messageId);
        const record = await getFromDb(key, null);
        if (!record) return null;
        record.roleMap = { ...record.roleMap, [emojiKey]: roleId };
        await db.set(key, record);
        return mapRow({ message_id: messageId, guild_id: record.guildId, channel_id: record.channelId, role_map: record.roleMap });
    } catch (error) {
        logger.error(`Error setting role mapping on panel ${messageId}:`, error);
        throw error;
    }
}

export async function removeRoleMapping(messageId, emojiKey) {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(
                `UPDATE ${tables.reaction_role_messages}
                 SET role_map = role_map - $2::text, updated_at = CURRENT_TIMESTAMP
                 WHERE message_id = $1 RETURNING *`,
                [messageId, emojiKey],
            );
            return mapRow(result.rows[0]);
        }
        const key = degradedKey(messageId);
        const record = await getFromDb(key, null);
        if (!record) return null;
        delete record.roleMap[emojiKey];
        await db.set(key, record);
        return mapRow({ message_id: messageId, guild_id: record.guildId, channel_id: record.channelId, role_map: record.roleMap });
    } catch (error) {
        logger.error(`Error removing role mapping on panel ${messageId}:`, error);
        throw error;
    }
}

export async function deletePanel(messageId) {
    await ensureInitialized();
    try {
        if (isSqlReady()) {
            const tables = await getTables();
            const result = await db.db.pool.query(`DELETE FROM ${tables.reaction_role_messages} WHERE message_id = $1 RETURNING message_id`, [messageId]);
            return result.rows.length > 0;
        }
        const key = degradedKey(messageId);
        const existing = await getFromDb(key, null);
        if (!existing) return false;
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting reaction role panel ${messageId}:`, error);
        throw error;
    }
}
