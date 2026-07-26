import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';
import { createEditableMessage } from '../../utils/database/editableMessages.js';

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];

const MAX_ALLOWED_ROLES = 5;

function resolveTargetChannel(interaction) {
    const selected = interaction.options.getChannel('channel');
    if (selected) {
        return selected;
    }

    if (!interaction.channel || !TEXT_CHANNEL_TYPES.includes(interaction.channel.type)) {
        return null;
    }

    return interaction.channel;
}

export default {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Send a plain message as the bot')
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('The message the bot should send')
                .setRequired(true)
                .setMaxLength(2000),
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('Channel to send in (defaults to the current channel)')
                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                .setRequired(false),
        )
        .addBooleanOption((option) =>
            option
                .setName('editable')
                .setDescription('Let selected roles edit this message later with /editmessage')
                .setRequired(false),
        )
        .addRoleOption((option) =>
            option.setName('role1').setDescription('Role allowed to edit this message'))
        .addRoleOption((option) =>
            option.setName('role2').setDescription('Role allowed to edit this message'))
        .addRoleOption((option) =>
            option.setName('role3').setDescription('Role allowed to edit this message'))
        .addRoleOption((option) =>
            option.setName('role4').setDescription('Role allowed to edit this message'))
        .addRoleOption((option) =>
            option.setName('role5').setDescription('Role allowed to edit this message'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false),
    category: 'moderation',
    abuseProtection: { maxAttempts: 8, windowMs: 60_000 },

    async execute(interaction, _config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferSuccess) {
            logger.warn('Say interaction defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'say',
            });
            return;
        }

        const rawMessage = interaction.options.getString('message');
        const message = sanitizeInput(rawMessage, 2000);

        if (!message) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Message cannot be empty.',
            });
        }

        const channel = resolveTargetChannel(interaction);
        if (!channel) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Choose a text channel or run this command in one.',
            });
        }

        const memberPermissions = channel.permissionsFor(interaction.member);
        const botPermissions = channel.permissionsFor(interaction.guild.members.me);

        if (!memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `You do not have permission to send messages in ${channel}.`,
            });
        }

        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `I do not have permission to send messages in ${channel}.`,
            });
        }

        const editable = interaction.options.getBoolean('editable') ?? false;
        const allowedRoles = editable
            ? Array.from({ length: MAX_ALLOWED_ROLES }, (_, i) => interaction.options.getRole(`role${i + 1}`))
                .filter(Boolean)
            : [];

        // No button, no components, no embed — the posted message is 100%
        // plain content. Nobody in the channel sees any indication that it's
        // editable; editing happens entirely out-of-band via /editmessage.
        const sentMessage = await channel.send({ content: message });

        let registrationFailed = false;
        if (editable) {
            try {
                await createEditableMessage({
                    messageId: sentMessage.id,
                    guildId: interaction.guild.id,
                    channelId: channel.id,
                    creatorId: interaction.user.id,
                    allowedRoles: allowedRoles.map((role) => role.id),
                });
            } catch (error) {
                registrationFailed = true;
                logger.error(`Failed to register editable message ${sentMessage.id}:`, error);
            }
        }

        await logEvent({
            client,
            guild: interaction.guild,
            event: {
                action: 'Bot Message Sent',
                target: `${channel} (${channel.id})`,
                executor: `${interaction.user.tag} (${interaction.user.id})`,
                reason: message.length > 200
                    ? `${message.slice(0, 197)}...`
                    : message,
                metadata: {
                    channelId: channel.id,
                    messageId: sentMessage.id,
                    moderatorId: interaction.user.id,
                    messageLength: message.length,
                    editable,
                    allowedRoleIds: allowedRoles.map((role) => role.id),
                },
            },
        });

        const editableNote = !editable
            ? ''
            : registrationFailed
                ? '\n\n⚠️ Editing could not be enabled for this message due to a database error — check the bot logs.'
                : allowedRoles.length > 0
                    ? `\n\nEditable via \`/editmessage\` by: ${allowedRoles.map((role) => `${role}`).join(', ')} (and Administrators).`
                    : '\n\nEditable via `/editmessage`, but no roles were selected — only Administrators can use it.';

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'Message Sent',
                    `Posted in ${channel}. [Jump to message](${sentMessage.url})${editableNote}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
