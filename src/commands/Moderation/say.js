import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';
import { sendSayMessage, stashPendingSay, buildEditableNote } from '../../services/sayService.js';

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
                .setDescription('The message to send (leave blank for a popup text box)')
                .setRequired(false)
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

    // NOTE: this command intentionally does NOT defer immediately at the top
    // anymore. If "message" is left blank we need to call showModal() as the
    // very first response, which is only allowed before any defer/reply.
    async execute(interaction, _config, client) {
        const channel = resolveTargetChannel(interaction);
        if (!channel) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Choose a text channel or run this command in one.',
            });
            return;
        }

        const memberPermissions = channel.permissionsFor(interaction.member);
        const botPermissions = channel.permissionsFor(interaction.guild.members.me);

        if (!memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
            await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `You do not have permission to send messages in ${channel}.`,
            });
            return;
        }

        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
            await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `I do not have permission to send messages in ${channel}.`,
            });
            return;
        }

        const editable = interaction.options.getBoolean('editable') ?? false;
        const allowedRoleIds = editable
            ? Array.from({ length: MAX_ALLOWED_ROLES }, (_, i) => interaction.options.getRole(`role${i + 1}`))
                .filter(Boolean)
                .map((role) => role.id)
            : [];

        const rawMessage = interaction.options.getString('message');

        if (rawMessage) {
            // Message typed inline — send right away, same as before.
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

            const message = sanitizeInput(rawMessage, 2000);
            if (!message) {
                await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'Message cannot be empty.',
                });
                return;
            }

            const { sentMessage, registrationFailed } = await sendSayMessage({
                client,
                guild: interaction.guild,
                channel,
                user: interaction.user,
                message,
                editable,
                allowedRoleIds,
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        'Message Sent',
                        `Posted in ${channel}. [Jump to message](${sentMessage.url})${buildEditableNote(editable, registrationFailed, allowedRoleIds)}`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Message left blank — pop a proper multi-line text box instead of
        // making someone type a long message into a single-line slash option.
        const token = interaction.id;
        stashPendingSay(token, {
            channelId: channel.id,
            editable,
            allowedRoleIds,
        });

        const modal = new ModalBuilder()
            .setCustomId(`say_modal:${token}`)
            .setTitle('Send Message');

        const contentInput = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('Message content')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000);

        modal.addComponents(new ActionRowBuilder().addComponents(contentInput));

        await interaction.showModal(modal);
    },
};
