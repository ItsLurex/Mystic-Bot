import { pgDb } from './postgresDatabase.js';
import { pgConfig } from '../config/database/postgres.js';

class EditableMessages {
    async create({
        messageId,
        guildId,
        channelId,
        creatorId,
        allowedRoles = [],
    }) {
        await pgDb.pool.query(
            `INSERT INTO ${pgConfig.tables.editable_messages}
            (message_id, guild_id, channel_id, creator_id, allowed_roles)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (message_id)
            DO UPDATE SET
                guild_id = EXCLUDED.guild_id,
                channel_id = EXCLUDED.channel_id,
                creator_id = EXCLUDED.creator_id,
                allowed_roles = EXCLUDED.allowed_roles,
                updated_at = CURRENT_TIMESTAMP`,
            [
                messageId,
                guildId,
                channelId,
                creatorId,
                JSON.stringify(allowedRoles),
            ]
        );
    }

    async get(messageId) {
        const result = await pgDb.pool.query(
            `SELECT *
             FROM ${pgConfig.tables.editable_messages}
             WHERE message_id = $1`,
            [messageId]
        );

        return result.rows[0] ?? null;
    }

    async updateRoles(messageId, roles) {
        await pgDb.pool.query(
            `UPDATE ${pgConfig.tables.editable_messages}
             SET allowed_roles = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE message_id = $1`,
            [
                messageId,
                JSON.stringify(roles),
            ]
        );
    }

    async delete(messageId) {
        await pgDb.pool.query(
            `DELETE FROM ${pgConfig.tables.editable_messages}
             WHERE message_id = $1`,
            [messageId]
        );
    }

    async canEdit(messageId, member) {
        const data = await this.get(messageId);

        if (!data)
            return false;

        import { PermissionFlagsBits } from 'discord.js';
            return true;

        let roles = data.allowed_roles;

        if (typeof roles === 'string')
            roles = JSON.parse(roles);

        return member.roles.cache.some(role => roles.includes(role.id));
    }
}

export default new EditableMessages();
