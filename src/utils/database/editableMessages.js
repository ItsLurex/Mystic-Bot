import { pgDb } from '../postgresDatabase.js';
import { pgConfig } from '../../config/database/postgres.js';

const TABLE = pgConfig.tables.editable_messages;

export async function createEditableMessage({
    messageId,
    guildId,
    channelId,
    creatorId,
    allowedRoles = [],
}) {
    if (!pgDb.isAvailable()) return false;

    await pgDb.pool.query(
        `
        INSERT INTO ${TABLE}
        (
            message_id,
            guild_id,
            channel_id,
            creator_id,
            allowed_roles,
            updated_at
        )
        VALUES
        (
            $1,$2,$3,$4,$5,CURRENT_TIMESTAMP
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
            allowed_roles = EXCLUDED.allowed_roles,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
            messageId,
            guildId,
            channelId,
            creatorId,
            JSON.stringify(allowedRoles),
        ]
    );

    return true;
}

export async function getEditableMessage(messageId) {
    if (!pgDb.isAvailable()) return null;

    const result = await pgDb.pool.query(
        `
        SELECT *
        FROM ${TABLE}
        WHERE message_id = $1
        `,
        [messageId]
    );

    if (!result.rows.length) {
        return null;
    }

    return result.rows[0];
}

export async function updateEditableRoles(messageId, allowedRoles) {
    if (!pgDb.isAvailable()) return false;

    await pgDb.pool.query(
        `
        UPDATE ${TABLE}
        SET
            allowed_roles = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE message_id = $1
        `,
        [
            messageId,
            JSON.stringify(allowedRoles),
        ]
    );

    return true;
}

export async function deleteEditableMessage(messageId) {
    if (!pgDb.isAvailable()) return false;

    await pgDb.pool.query(
        `
        DELETE FROM ${TABLE}
        WHERE message_id = $1
        `,
        [messageId]
    );

    return true;
}

export async function listEditableMessages(guildId) {
    if (!pgDb.isAvailable()) return [];

    const result = await pgDb.pool.query(
        `
        SELECT *
        FROM ${TABLE}
        WHERE guild_id = $1
        ORDER BY created_at ASC
        `,
        [guildId]
    );

    return result.rows;
}
