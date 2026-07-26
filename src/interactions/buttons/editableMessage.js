import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
} from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getEditableMessage, canEditMessage } from '../../../utils/database/editableMessages.js';

/**
 * Handles the "✏️ Edit" button attached to /say messages created with
 * editable:true. Visible to everyone in the channel (Discord has no way to
 * hide a component from specific roles), but only members who hold one of
 * the roles selected at creation time (or Administrators) are let through —
 * everyone else gets a private "no permission" reply.
 */
export default {
    name: 'editable_message_edit',

    async execute(interaction, client, _args) {
        const data = await getEditableMessage(interaction.message.id);

        if (!data) {
            await interaction.reply({
                content: 'This message is no longer editable.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const allowed = await canEditMessage(interaction.message.id, interaction.member);
        if (!allowed) {
            await interaction.reply({
                content: 'You do not have permission to edit this message.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`editable_message_modal:${interaction.message.id}`)
            .setTitle('Edit Message');

        const contentInput = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('New message content')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setValue(interaction.message.content?.slice(0, 4000) || '');

        modal.addComponents(new ActionRowBuilder().addComponents(contentInput));

        try {
            await interaction.showModal(modal);
        } catch (error) {
            logger.error(`Error showing edit modal for message ${interaction.message.id}:`, error);
            throw error;
        }
    },
};
