import { MessageFlags } from 'discord.js';
import editableMessages from '../utils/editableMessages.js';

const editableMessageModal = {
    name: 'editable_message_modal',

    async execute(interaction, client, args) {
        const messageId = args[0];

        const data = await editableMessages.get(messageId);

        if (!data) {
            return interaction.reply({
                content: 'This message is no longer editable.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const allowed = await editableMessages.canEdit(
            messageId,
            interaction.member,
        );

        if (!allowed) {
            return interaction.reply({
                content: 'You do not have permission to edit this message.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const channel = await client.channels.fetch(data.channel_id);
        const message = await channel.messages.fetch(messageId);

        const newContent = interaction.fields.getTextInputValue('content');

        await message.edit({
            content: newContent,
        });

        await interaction.reply({
            content: '✅ Message updated.',
            flags: MessageFlags.Ephemeral,
        });
    },
};

export default editableMessageModal;
