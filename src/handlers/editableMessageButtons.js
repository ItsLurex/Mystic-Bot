import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from 'discord.js';

import editableMessages from '../utils/database/editableMessages.js';

const editButtonHandler = {
    name: 'editable_message_edit',

    async execute(interaction) {

        const data = await editableMessages.get(interaction.message.id);

        if (!data)
            return interaction.reply({
                content: 'This message is no longer editable.',
                ephemeral: true,
            });

        const allowed = await editableMessages.canEdit(
            interaction.message.id,
            interaction.member,
        );

        if (!allowed)
            return interaction.reply({
                content: 'You cannot edit this message.',
                ephemeral: true,
            });

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
            new ActionRowBuilder().addComponents(input),
        );

        await interaction.showModal(modal);
    },
};

const editModalHandler = {
    name: 'editable_message_modal',

    async execute(interaction, client, args) {

        const messageId = args[0];

        const data = await editableMessages.get(messageId);

        if (!data)
            return interaction.reply({
                content: 'This message is no longer editable.',
                ephemeral: true,
            });

        const allowed = await editableMessages.canEdit(
            messageId,
            interaction.member,
        );

        if (!allowed)
            return interaction.reply({
                content: 'You cannot edit this message.',
                ephemeral: true,
            });

        const channel = await interaction.guild.channels.fetch(data.channel_id);

        const message = await channel.messages.fetch(messageId);

        const newContent =
            interaction.fields.getTextInputValue('content');

        await message.edit({
            content: newContent,
        });

        await interaction.reply({
            content: '✅ Message updated.',
            ephemeral: true,
        });
    },
};

export default editButtonHandler;

export {
    editModalHandler,
};
