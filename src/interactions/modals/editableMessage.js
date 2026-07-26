import { MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { logEvent } from '../../../utils/moderation.js';
import { sanitizeInput } from '../../../utils/validation.js';
import { getEditableMessage, canEditMessage, deleteEditableMessage } from '../../../utils/database/editableMessages.js';

/**
 * Handles submission of the edit modal opened from the "✏️ Edit" button on
 * /say messages created with editable:true. Re-checks permission at submit
 * time (not just when the button was pressed) since roles can change in
 * between, then edits the live Discord message directly.
 */
export default {
    name: 'editable_message_modal',

    async execute(interaction, client, args) {
        const messageId = args[0];

        const data = await getEditableMessage(messageId);
        if (!data) {
            await interaction.reply({
                content: 'This message is no longer editable.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const allowed = await canEditMessage(messageId, interaction.member);
        if (!allowed) {
            await interaction.reply({
                content: 'You do not have permission to edit this message.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const rawContent = interaction.fields.getTextInputValue('content');
        const newContent = sanitizeInput(rawContent, 2000);

        if (!newContent) {
            await interaction.reply({
                content: 'Message content cannot be empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        try {
            const channel = await client.channels.fetch(data.channelId);
            const message = await channel.messages.fetch(messageId);

            await message.edit({ content: newContent });

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: 'Editable Message Updated',
                    target: `${channel} (${channel.id})`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    reason: newContent.length > 200 ? `${newContent.slice(0, 197)}...` : newContent,
                    metadata: {
                        channelId: channel.id,
                        messageId,
                        editorId: interaction.user.id,
                    },
                },
            });

            await interaction.reply({
                content: '✅ Message updated.',
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            if (error.code === 10008) {
                // Unknown Message — it was deleted out from under us; clean up the row.
                await deleteEditableMessage(messageId).catch(() => {});
                await interaction.reply({
                    content: 'That message no longer exists, so it can no longer be edited.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            logger.error(`Error editing message ${messageId}:`, error);
            throw error;
        }
    },
};
