import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    PermissionFlagsBits,
} from 'discord.js';

import editableMessages from '../utils/editableMessages.js';

export const editableMessageButton = {
    name: 'editable_message_edit',

    async execute(interaction) {
        const data = await editableMessages.get(interaction.message.id);

        if (!data) {
            return interaction.reply({
                content: 'This message is no longer editable.',
                ephemeral: true,
            });
        }

        if (
            interaction.user.id !== data.creator_id &&
            !interaction.member.permissions.has(PermissionFlagsBits.Administrator) &&
            !(await editableMessages.canEdit(interaction.message.id, interaction.member))
        ) {
            return interaction.reply({
                content: "You don't have permission to edit this message.",
                ephemeral: true,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`editable_message_modal:${interaction.message.id}`)
            .setTitle('Edit Message');

        const input = new TextInputBuilder()
            .setCustomId('content')
            .setLabel('Message')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setValue(interaction.message.content)
            .setMaxLength(2000);

        modal.addComponents(
            new ActionRowBuilder().addComponents(input)
        );

        await interaction.showModal(modal);
    }
};

export const editableMessageModal = {
    name: 'editable_message_modal',

    async execute(interaction, client, args) {
        const messageId = args[0];

        const data = await editableMessages.get(messageId);

        if (!data) {
            return interaction.reply({
                content: 'Message not found.',
                ephemeral: true,
            });
        }

        const channel = await client.channels.fetch(data.channel_id);

        const message = await channel.messages.fetch(messageId);

        const content = interaction.fields.getTextInputValue('content');

        await message.edit({
            content,
            components: message.components,
        });

        await interaction.reply({
            content: 'Message updated.',
            ephemeral: true,
        });
    }
};
