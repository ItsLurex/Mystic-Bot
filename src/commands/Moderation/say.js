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
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';
import { saveEditableMessage } from '../../services/editableMessageService.js';

const TEXT_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

function resolveTargetChannel(interaction) {
  const selected = interaction.options.getChannel('channel');
  if (selected) return selected;

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
        .addChannelTypes(...TEXT_CHANNEL_TYPES),
    )
    .addBooleanOption((option) =>
      option
        .setName('editable')
        .setDescription('Add an Edit button and allow selected roles to edit it'),
    )
    .addRoleOption((option) =>
      option.setName('role1').setDescription('First role allowed to edit'),
    )
    .addRoleOption((option) =>
      option.setName('role2').setDescription('Second role allowed to edit'),
    )
    .addRoleOption((option) =>
      option.setName('role3').setDescription('Third role allowed to edit'),
    )
    .addRoleOption((option) =>
      option.setName('role4').setDescription('Fourth role allowed to edit'),
    )
    .addRoleOption((option) =>
      option.setName('role5').setDescription('Fifth role allowed to edit'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  category: 'moderation',
  abuseProtection: { maxAttempts: 8, windowMs: 60_000 },

  async execute(interaction, _config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });

    if (!deferSuccess) return;

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

    const roles = ['role1', 'role2', 'role3', 'role4', 'role5']
      .map((name) => interaction.options.getRole(name))
      .filter(Boolean);

    const roleIds = [...new Set(roles.map((role) => role.id))];

    if (editable && roleIds.length === 0) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Select at least one role when editable is enabled.',
      });
    }

    if (roleIds.includes(interaction.guild.id)) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Do not use @everyone as an editable role.',
      });
    }

    const sentMessage = await channel.send({
      content: message,
      components: editable
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('editable_message:pending')
                .setLabel('Edit')
                .setStyle(ButtonStyle.Secondary),
            ),
          ]
        : [],
    });

    if (editable) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`editable_message:${sentMessage.id}`)
          .setLabel('Edit')
          .setStyle(ButtonStyle.Secondary),
      );

      await sentMessage.edit({
        components: [row],
      });

      await saveEditableMessage({
        guildId: interaction.guildId,
        channelId: channel.id,
        messageId: sentMessage.id,
        roleIds,
        createdBy: interaction.user.id,
      });
    }

    await logEvent({
      client,
      guild: interaction.guild,
      event: {
        action: editable ? 'Editable Bot Message Sent' : 'Bot Message Sent',
        target: `${channel} (${channel.id})`,
        executor: `${interaction.user.tag} (${interaction.user.id})`,
        reason:
          message.length > 200
            ? `${message.slice(0, 197)}...`
            : message,
        metadata: {
          channelId: channel.id,
          messageId: sentMessage.id,
          moderatorId: interaction.user.id,
          messageLength: message.length,
          editable,
          roleIds,
        },
      },
    });

await InteractionHelper.safeDeleteReply(interaction);
  },
};
