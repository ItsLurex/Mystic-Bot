import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { infoEmbed } from '../../../utils/embeds.js';
import { listStickies } from '../../../services/stickyService.js';

const MAX_LISTED = 25;

/**
 * Best-effort "last repost" time: Discord snowflake IDs encode their
 * creation timestamp, so we can read it straight off the stored message id
 * without an extra API call or an extra database column.
 */
function lastRepostLabel(sticky) {
    if (!sticky.lastMessageId) {
        return 'Never posted';
    }

    try {
        const timestamp = Number((BigInt(sticky.lastMessageId) >> 22n) + 1420070400000n);
        return `<t:${Math.floor(timestamp / 1000)}:R>`;
    } catch {
        return 'Unknown';
    }
}

/**
 * Handles /sticky list — displays every sticky configured in the guild
 * with its channel, status, threshold, and last repost time.
 */
export async function handleList(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) {
        logger.warn('[Sticky] Failed to defer /sticky list interaction', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
        });
        return;
    }

    const { guild } = interaction;

    try {
        const stickies = await listStickies(guild.id);

        if (stickies.length === 0) {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [infoEmbed('No sticky messages are configured in this server yet. Use `/sticky set` to create one.')],
            });
            return;
        }

        const lines = stickies.slice(0, MAX_LISTED).map((sticky) => {
            const channelMention = `<#${sticky.channelId}>`;
            const status = sticky.enabled ? 'Enabled ✅' : 'Paused ⏸️';
            const thresholdLabel = `${sticky.threshold} message${sticky.threshold === 1 ? '' : 's'}`;
            return `${channelMention} — ${status} · Threshold: ${thresholdLabel} · Last repost: ${lastRepostLabel(sticky)}`;
        });

        const truncationNotice = stickies.length > MAX_LISTED
            ? `\n\n…and ${stickies.length - MAX_LISTED} more.`
            : '';

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed(`**Sticky Messages (${stickies.length})**\n\n${lines.join('\n')}${truncationNotice}`)],
        });
    } catch (error) {
        logger.error(`[Sticky] Error listing stickies for guild ${guild.id}:`, error);
        throw error;
    }
}
