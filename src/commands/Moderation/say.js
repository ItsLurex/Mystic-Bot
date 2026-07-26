import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';
import editableMessages from '../../utils/editableMessages.js';
import { createEditableMessage } from '../../utils/database/editableMessages.js';

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];

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

    .addStringOption(option =>
        option
            .setName('message')
            .setDescription('The message the bot should send')
            .setRequired(true)
            .setMaxLength(2000)
    )

    .addBooleanOption(option =>
        option
            .setName('editable')
            .setDescription('Allow selected staff roles to edit this message later')
            .setRequired(false)
    )

    .addRoleOption(option =>
        option
            .setName('role1')
            .setDescription('Allowed role #1')
    )

    .addRoleOption(option =>
        option
            .setName('role2')
            .setDescription('Allowed role #2')
    )

    .addRoleOption(option =>
        option
            .setName('role3')
            .setDescription('Allowed role #3')
    )

    .addRoleOption(option =>
        option
            .setName('role4')
            .setDescription('Allowed role #4')
    )

    .addRoleOption(option =>
        option
            .setName('role5')
            .setDescription('Allowed role #5')
    )

        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('Channel to send in (defaults to the current channel)')
                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                .setRequired(false),
        )
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

const roles = [
    interaction.options.getRole('role1'),
    interaction.options.getRole('role2'),
    interaction.options.getRole('role3'),
    interaction.options.getRole('role4'),
    interaction.options.getRole('role5'),
].filter(Boolean);
let sentMessage;

if (!editable) {

    console.log("1");

    sentMessage = await channel.send({
        content: message,
    });

    console.log("2");

} else {

    console.log("1");

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('editable_message_edit')
            .setLabel('✏️ Edit')
            .setStyle(ButtonStyle.Secondary)
    );

    sentMessage = await channel.send({
        content: message,
        components: [row],
    });

    console.log("2");

    console.log("3");

    await editableMessages.create({
        messageId: sentMessage.id,
        guildId: interaction.guild.id,
        channelId: channel.id,
        creatorId: interaction.user.id,
        allowedRoles: roles.map(r => r.id),
    });

    console.log("4");
}

        console.log("5");
        
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
                },
            },
        });

        console.log("6");

        console.log("7");
        
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'Message Sent',
                    `Posted in ${channel}. [Jump to message](${sentMessage.url})`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        console.log("8");
    },
};
