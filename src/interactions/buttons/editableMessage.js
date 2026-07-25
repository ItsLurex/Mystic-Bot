import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import {
  getEditableMessage,
  hasAllowedRole,
} from '../../../services/editableMessageService.js';

export default {
  name: 'editable_message',

  async execute(interaction) {
    const [, messageId] = interaction.customId.split(':');

    const record = await getEditableMessage(messageId);

    if (!record || record.guild_id !== interaction.guildId) {
      return interaction.reply({
        content: 'This editable message record no longer exists.',
        ephemeral: true,
      });
    }

    if (!hasAllowedRole(interaction.member, record.role_ids || [])) {
      return interaction.reply({
        content: 'You do not have permission to edit this message.',
        ephemeral: true,
      });
    }

    const channel = await interaction.guild.channels
      .fetch(record.channel_id)
      .catch(() => null);

    if (!channel || !channel.isTextBased()) {
      return interaction.reply({
        content: 'The original channel no longer exists.',
        ephemeral: true,
      });
    }

    const message = await channel.messages
      .fetch(record.message_id)
      .catch(() => null);

    if (!message) {
      return interaction.reply({
        content: 'The original message was deleted.',
        ephemeral: true,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`editable_message_modal:${messageId}`)
      .setTitle('Edit bot message');

    const contentInput = new TextInputBuilder()
      .setCustomId('content')
      .setLabel('Message content')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000)
      .setValue(message.content || ' ');

    modal.addComponents(
      new ActionRowBuilder().addComponents(contentInput),
    );

    await interaction.showModal(modal);
  },
};
