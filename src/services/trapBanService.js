// trapBanService.js
//
// Business logic for the Auto-Ban trap-channel feature: in-memory cache of
// trap-channel rules (loaded on startup, kept in sync on writes), the
// messageCreate hook that actually bans someone who posts in a trap
// channel, and the cron-checked logic that auto-unbans temporary bans once
// their duration expires.

import { logger } from '../utils/logger.js';
import { isIgnoredMember } from './ignoredRolesService.js';
import { ModerationService } from './moderation/moderationService.js';
import * as trapBanRepository from '../utils/database/trapBanRules.js';

/** @type {Map<string, {guildId: string, banDurationDays: number, dmMessage: string|null}>} */
const ruleCache = new Map();

/** Loads every trap-ban rule into memory. Call once at startup. */
export async function initTrapBanCache() {
    ruleCache.clear();

    try {
        const rules = await trapBanRepository.getAllRules();
        for (const rule of rules) {
            ruleCache.set(rule.channelId, rule);
        }
        logger.info(`[AutoBan] Loaded ${rules.length} trap-channel rule(s) into cache`);
    } catch (error) {
        logger.error('[AutoBan] Failed to warm the trap-ban rule cache:', error);
    }

    return ruleCache.size;
}

export function getCachedRule(channelId) {
    return ruleCache.get(channelId) || null;
}

export async function listRules(guildId) {
    return trapBanRepository.listRulesForGuild(guildId);
}

/** Creates or replaces the trap rule for a channel. */
export async function setRule(guildId, channelId, banDurationDays, dmMessage) {
    const rule = await trapBanRepository.setRule({ guildId, channelId, banDurationDays, dmMessage });
    ruleCache.set(channelId, rule);
    return rule;
}

/** Removes a channel's trap rule. Returns true if one existed. */
export async function removeRule(channelId) {
    const removed = await trapBanRepository.deleteRule(channelId);
    ruleCache.delete(channelId);
    return removed;
}

/**
 * Entry point called from messageCreate for every guild message — deliberately
 * run early (alongside Auto-Moderation), before sticky/autoreact/counting
 * handling, since a banned member's message shouldn't be processed further.
 *
 * @returns {Promise<boolean>} true if the member was banned, so the caller
 * can skip running any further handlers against this message.
 */
export async function handleTrapBanMessage(message, client) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system) {
        return false;
    }

    const rule = getCachedRule(message.channel.id);
    if (!rule) return false;

    // Staff/Owner (or anyone on the ignored-roles list) can never be caught
    // by this, even by accident — this is a high-stakes trigger.
    if (isIgnoredMember(message.member)) return false;

    try {
        const dmMessage = rule.dmMessage
            || `You have been banned from **${message.guild.name}** for posting in a restricted channel.`;

        const result = await ModerationService.banUser({
            guild: message.guild,
            user: message.author,
            moderator: message.guild.members.me,
            reason: `Auto-ban: posted in trap channel #${message.channel.name}`,
            deleteDays: 1,
            notify: true,
            dmMessage,
        });

        if (rule.banDurationDays > 0) {
            const unbanAt = new Date(Date.now() + rule.banDurationDays * 24 * 60 * 60 * 1000);
            await trapBanRepository.scheduleUnban(message.guild.id, message.author.id, unbanAt);
        }

        logger.info(`[AutoBan] Banned ${message.author.tag} (${message.author.id}) for posting in trap channel ${message.channel.id}`, {
            caseId: result.caseId,
            durationDays: rule.banDurationDays,
        });

        return true;
    } catch (error) {
        logger.error(`[AutoBan] Failed to ban ${message.author.id} for trap channel ${message.channel.id}:`, error);
        return false;
    }
}

/**
 * Cron-checked task (see app.js): finds every temporary trap-ban whose
 * duration has expired and unbans them. Never throws — a failed unban for
 * one user must not block the rest of the batch.
 */
export async function checkExpiredTrapBans(client) {
    const due = await trapBanRepository.getDueUnbans();
    if (due.length === 0) return;

    logger.info(`[AutoBan] Processing ${due.length} expired temporary ban(s)`);

    for (const entry of due) {
        try {
            const guild = client.guilds.cache.get(entry.guildId);
            if (!guild) {
                await trapBanRepository.deleteScheduledUnban(entry.id);
                continue;
            }

            await guild.members.unban(entry.userId, 'Auto-ban duration expired').catch((error) => {
                // Already unbanned manually, or never actually banned — not an error worth keeping the record for.
                logger.debug(`[AutoBan] Unban skipped for ${entry.userId} in guild ${entry.guildId}: ${error.message}`);
            });

            await trapBanRepository.deleteScheduledUnban(entry.id);
        } catch (error) {
            logger.error(`[AutoBan] Error processing expired ban for ${entry.userId} in guild ${entry.guildId}:`, error);
        }
    }
}
