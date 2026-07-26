import { query } from '../database.js';

export async function createEditableMessage({
    messageId,
    guildId,
    channelId,
    creatorId,
    allowedRoles = [],
}) {
    await query(
        `
        INSERT INTO editable_messages
        (
            message_id,
            guild_id,
            channel_id,
            creator_id,
            allowed_roles
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
            messageId,
            guildId,
            channelId,
            creatorId,
            JSON.stringify(allowedRoles),
        ]
    );
}

export async function getEditableMessage(messageId) {
    const result = await query(
        `
        SELECT *
        FROM editable_messages
        WHERE message_id = $1
        `,
        [messageId]
    );

    return result.rows[0] ?? null;
}

export async function deleteEditableMessage(messageId) {
    await query(
        `
        DELETE FROM editable_messages
        WHERE message_id = $1
        `,
        [messageId]
    );
}
