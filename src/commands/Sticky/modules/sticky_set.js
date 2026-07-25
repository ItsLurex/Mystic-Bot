import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes, TitanBotError } from '../../../utils/errorHandler.js';
import { successEmbed } from '../../../utils/embeds.js';
import { buildEmbedJsonFromOptions, createStickyForChannel } from '../../../services/stickyService.js';

/**
 * Handles /sticky set — creates a new sticky message for a channel and
 * posts it immediately.
 */
export async function handleSet(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) {
        logger.warn('[Sticky] Failed to defer /sticky set interaction', {
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

    const content = options.getString('content');
    const threshold = options.getInteger('threshold') ?? 1;

    try {
        const embedJson = buildEmbedJsonFromOptions({
            title: options.getString('title'),
            description: options.getString('description'),
            color: options.getString('color'),
            thumbnail: options.getString('thumbnail'),
            image: options.getString('image'),
            footer: options.getString('footer'),
            author: options.getString('author'),
            timestamp: options.getBoolean('timestamp'),
        });

        const sticky = await createStickyForChannel({
            guild,
            channel: resolvedChannel,
            messageContent: content,
            embedJson,
            threshold,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `**Sticky message created!**\n\n` +
                `**Channel:** ${resolvedChannel}\n` +
                `**Threshold:** repost every ${sticky.threshold} message${sticky.threshold === 1 ? '' : 's'}\n\n` +
                `Use \`/sticky edit\` to change its content, \`/sticky pause\` to stop reposting, or \`/sticky remove\` to delete it.`,
            )],
        });
    } catch (error) {
        if (error instanceof TitanBotError) {
            await replyUserError(interaction, { type: error.type, message: error.userMessage });
            return;
        }
        logger.error(`[Sticky] Error creating sticky for channel ${resolvedChannel.id} in guild ${guild.id}:`, error);
        throw error;
    }
}
