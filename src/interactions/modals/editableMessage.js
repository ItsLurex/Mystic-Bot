import {
  getEditableMessage,
  hasAllowedRole,
  deleteEditableMessage,
} from '../../../services/editableMessageService.js';

export default {
  name: 'editable_message_modal',

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

    const content = interaction.fields
      .getTextInputValue('content')
      .trim();

    if (!content) {
      return interaction.reply({
        content: 'Message content cannot be empty.',
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
      await deleteEditableMessage(messageId);

      return interaction.reply({
        content:
          'The original message was deleted, so I removed its editable record.',
        ephemeral: true,
      });
    }

    await message.edit({
      content,
    });

    await interaction.reply({
      content: 'Message updated successfully.',
      ephemeral: true,
    });
  },
};
