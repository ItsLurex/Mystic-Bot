import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
} from 'discord.js';

import editableMessages from '../utils/editableMessages.js';

const editButtonHandler = {
    name: 'editable_message_edit',

    async execute(interaction) {
        const data = await editableMessages.get(interaction.message.id);

        if (!data) {
            return interaction.reply({
                content: 'This message is no longer editable.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const allowed = await editableMessages.canEdit(
            interaction.message.id,
            interaction.member,
        );

        if (!allowed) {
            return interaction.reply({
                content: 'You do not have permission to edit this message.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`editable_message_modal:${interaction.message.id}`)
            .setTitle('Edit Message');

        const contentInput = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('New message')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setValue(interaction.message.content);

        modal.addComponents(
            new ActionRowBuilder().addComponents(contentInput),
        );

        await interaction.showModal(modal);
    },
};
