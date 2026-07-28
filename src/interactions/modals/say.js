import { MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { successEmbed } from '../../utils/embeds.js';
import { sanitizeMultilineInput } from '../../utils/validation.js';
import { sendSayMessage, popPendingSay, buildEditableNote } from '../../services/sayService.js';

/**
 * Handles submission of the popup text box opened by /say when the
 * "message" option is left blank.
 */
export default {
    name: 'say_modal',

    async execute(interaction, client, args) {
        const token = args[0];
        const pending = popPendingSay(token);

        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferSuccess) {
            logger.warn('Say modal defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
            });
            return;
        }

        if (!pending) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'This popup expired. Please run `/say` again.',
            });
            return;
        }

        const rawMessage = interaction.fields.getTextInputValue('content');
        const message = sanitizeMultilineInput(rawMessage, 2000);

        if (!message) {
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Message cannot be empty.',
            });
            return;
        }

        let channel;
        try {
            channel = await client.channels.fetch(pending.channelId);
        } catch (error) {
            logger.error(`Error fetching channel ${pending.channelId} for say_modal:`, error);
            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'That channel no longer exists.',
            });
            return;
        }

        const { sentMessage, registrationFailed } = await sendSayMessage({
            client,
            guild: interaction.guild,
            channel,
            user: interaction.user,
            message,
            editable: pending.editable,
            allowedRoleIds: pending.allowedRoleIds,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'Message Sent',
                    `Posted in ${channel}. [Jump to message](${sentMessage.url})${buildEditableNote(pending.editable, registrationFailed, pending.allowedRoleIds)}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
