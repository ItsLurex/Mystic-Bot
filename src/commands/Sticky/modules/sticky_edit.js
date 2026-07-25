import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes, TitanBotError } from '../../../utils/errorHandler.js';
import { successEmbed } from '../../../utils/embeds.js';
import { updateStickyForChannel } from '../../../services/stickyService.js';

const EMBED_OPTION_NAMES = ['title', 'description', 'color', 'thumbnail', 'image', 'footer', 'author', 'timestamp'];

/**
 * Handles /sticky edit — updates content, embed, threshold, and/or enabled
 * state of an existing sticky without deleting its database row.
 */
export async function handleEdit(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) {
        logger.warn('[Sticky] Failed to defer /sticky edit interaction', {
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

    const embedOptions = {
        title: options.getString('title'),
        description: options.getString('description'),
        color: options.getString('color'),
        thumbnail: options.getString('thumbnail'),
        image: options.getString('image'),
        footer: options.getString('footer'),
        author: options.getString('author'),
        timestamp: options.getBoolean('timestamp'),
    };
    const embedOptionsProvided = EMBED_OPTION_NAMES.some((name) => options.get(name) !== null);

    const content = options.getString('content');
    const threshold = options.getInteger('threshold');
    const enabled = options.getBoolean('enabled');

    const noChangesRequested = content === null
        && threshold === null
        && enabled === null
        && !embedOptionsProvided;

    if (noChangesRequested) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Provide at least one field to change (content, an embed option, threshold, or enabled).',
        });
        return;
    }

    try {
        const updates = {};
        if (content !== null) updates.messageContent = content;
        if (threshold !== null) updates.threshold = threshold;
        if (enabled !== null) updates.enabled = enabled;
        if (embedOptionsProvided) {
            updates.embedOptionsProvided = true;
            updates.embedOptions = embedOptions;
        }

        const sticky = await updateStickyForChannel(guild, resolvedChannel, updates);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `**Sticky message updated!**\n\n` +
                `**Channel:** ${resolvedChannel}\n` +
                `**Status:** ${sticky.enabled ? 'Enabled ✅' : 'Paused ⏸️'}\n` +
                `**Threshold:** repost every ${sticky.threshold} message${sticky.threshold === 1 ? '' : 's'}`,
            )],
        });
    } catch (error) {
        if (error instanceof TitanBotError) {
            await replyUserError(interaction, { type: error.type, message: error.userMessage });
            return;
        }
        logger.error(`[Sticky] Error editing sticky for channel ${resolvedChannel.id} in guild ${guild.id}:`, error);
        throw error;
    }
}
