import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { stashPendingSay } from '../../services/sayService.js';

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
        .setDescription('Send a message as the bot (opens a popup text box)')
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

    // NOTE: this command must NOT defer. Showing a modal has to be the very
    // first response to the interaction.
    async execute(interaction) {
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
