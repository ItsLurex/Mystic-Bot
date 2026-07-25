import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes, TitanBotError } from '../../../utils/errorHandler.js';
import { successEmbed } from '../../../utils/embeds.js';
import { pauseStickyForChannel } from '../../../services/stickyService.js';

/**
 * Handles /sticky pause — temporarily disables reposting for a channel's
 * sticky without deleting its database row.
 */
export async function handlePause(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) {
        logger.warn('[Sticky] Failed to defer /sticky pause interaction', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
        });
        return;
    }

    const { guild, options } = interaction;
    const channel = options.getChannel('channel');

    if (!channel) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Please select a valid channel.',
        });
        return;
    }

    const resolvedChannel = guild.channels.cache.get(channel.id);
    if (!resolvedChannel) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'I could not find that channel. It may have been deleted.',
        });
        return;
    }

    try {
        await pauseStickyForChannel(guild, resolvedChannel);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Sticky message in ${resolvedChannel} has been paused. It will stop reposting until you run \`/sticky resume\`.`)],
        });
    } catch (error) {
        if (error instanceof TitanBotError) {
            await replyUserError(interaction, { type: error.type, message: error.userMessage });
            return;
        }
        logger.error(`[Sticky] Error pausing sticky for channel ${resolvedChannel.id} in guild ${guild.id}:`, error);
        throw error;
    }
}
