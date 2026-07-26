import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getEditableMessage, canEditMessage, deleteEditableMessage } from '../../utils/database/editableMessages.js';

// Matches discord.com / discordapp.com / canary / ptb message links:
// https://discord.com/channels/<guildId>/<channelId>/<messageId>
const MESSAGE_LINK_PATTERN = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/;

function parseMessageLink(link) {
    const match = MESSAGE_LINK_PATTERN.exec(link.trim());
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId };
}

export default {
    data: new SlashCommandBuilder()
        .setName('editmessage')
        .setDescription('Edit a message previously sent with /say editable:true')
        .addStringOption((option) =>
            option
                .setName('message_link')
                .setDescription('Right-click the message → Copy Message Link')
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
        .setDMPermission(false),
    category: 'moderation',
    abuseProtection: { maxAttempts: 8, windowMs: 60_000 },

    // IMPORTANT: this command must NOT call InteractionHelper.safeDefer().
    // Showing a modal has to be the very first response to the interaction —
    // if it's deferred first, Discord will reject showModal().
    async execute(interaction) {
        const link = interaction.options.getString('message_link');
        const parsed = parseMessageLink(link);

        if (!parsed) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'That doesn\'t look like a message link. Right-click the message → **Copy Message Link**, then paste it here.',
            });
            return;
        }

        if (parsed.guildId !== interaction.guild.id) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'That message link is from a different server.',
            });
            return;
        }

        const data = await getEditableMessage(parsed.messageId);
        if (!data) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'That message is not editable — it wasn\'t sent with `/say editable:true`, or it has since been removed.',
            });
            return;
        }

        const allowed = await canEditMessage(parsed.messageId, interaction.member);
        if (!allowed) {
            await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You do not have permission to edit this message.',
            });
            return;
        }

        let message;
        try {
            const channel = await interaction.client.channels.fetch(parsed.channelId);
            message = await channel.messages.fetch(parsed.messageId);
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) {
                await deleteEditableMessage(parsed.messageId).catch(() => {});
                await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'That message (or its channel) no longer exists.',
                });
                return;
            }
            logger.error(`Error fetching message ${parsed.messageId} for /editmessage:`, error);
            throw error;
        }

        const modal = new ModalBuilder()
            .setCustomId(`editable_message_modal:${parsed.messageId}`)
            .setTitle('Edit Message');

        const contentInput = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('New message content')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setValue(message.content?.slice(0, 4000) || '');

        modal.addComponents(new ActionRowBuilder().addComponents(contentInput));

        await interaction.showModal(modal);
    },
};
