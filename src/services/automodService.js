// automodService.js
//
// Business logic for Auto-Moderation: in-memory cache of per-channel rules
// (loaded on startup, kept in sync on every write, exactly like sticky
// messages — the messageCreate hot path never queries Postgres directly),
// rule enforcement, and the bulk-purge helper behind /automod purge.

import { logger } from '../utils/logger.js';
import { logEvent } from '../utils/moderation.js';
import { isIgnoredMember } from './ignoredRolesService.js';
import * as automodRepository from '../utils/database/automodRules.js';

export const RULE_TYPES = {
    AUTO_DELETE: 'auto_delete',
    VOUCH_FORMAT: 'vouch_format',
};

const RULE_LABELS = {
    [RULE_TYPES.AUTO_DELETE]: 'Auto-delete every message',
    [RULE_TYPES.VOUCH_FORMAT]: 'Require "Vouch @user" format',
};

export function getRuleLabel(ruleType) {
    return RULE_LABELS[ruleType] || ruleType;
}

/** @type {Map<string, object>} channelId -> rule */
const ruleCache = new Map();

const WARNING_TTL_MS = 8000;
const VOUCH_PATTERN = /^vouch\s+<@!?(\d+)>/i;

/** Loads every automod rule into memory. Call once at startup. */
export async function initAutoModCache(client) {
    ruleCache.clear();

    try {
        const rules = await automodRepository.getAllRules();
        for (const rule of rules) {
            ruleCache.set(rule.channelId, rule);
        }
        logger.info(`[AutoMod] Loaded ${rules.length} channel rule(s) into cache`);
    } catch (error) {
        logger.error('[AutoMod] Failed to warm the automod rule cache:', error);
    }

    return ruleCache.size;
}

export function getCachedRule(channelId) {
    return ruleCache.get(channelId) || null;
}

export async function listRules(guildId) {
    return automodRepository.listRulesForGuild(guildId);
}

/** Creates or replaces the rule for a channel. */
export async function setRule(guildId, channelId, ruleType) {
    const rule = await automodRepository.setRule({ guildId, channelId, ruleType });
    ruleCache.set(channelId, rule);
    return rule;
}

/** Removes a channel's rule. Returns true if a rule existed. */
export async function removeRule(channelId) {
    const removed = await automodRepository.deleteRule(channelId);
    ruleCache.delete(channelId);
    return removed;
}

function isValidVouchMessage(content) {
    return VOUCH_PATTERN.test(content.trim());
}

async function sendTemporaryWarning(channel, text) {
    try {
        const warning = await channel.send({ content: text });
        setTimeout(() => {
            warning.delete().catch(() => {});
        }, WARNING_TTL_MS);
    } catch (error) {
        logger.debug(`[AutoMod] Could not send warning in channel ${channel.id}: ${error.message}`);
    }
}

async function deleteAndLog(message, client, ruleType, reasonText) {
    try {
        await message.delete();
    } catch (error) {
        // Already gone (e.g. deleted by someone else) — nothing to do.
        logger.debug(`[AutoMod] Could not delete message ${message.id}: ${error.message}`);
        return false;
    }

    await logEvent({
        client,
        guild: message.guild,
        event: {
            action: 'AutoMod Message Deleted',
            target: `${message.channel} (${message.channel.id})`,
            executor: 'AutoMod (automatic)',
            reason: reasonText,
            metadata: {
                channelId: message.channel.id,
                messageId: message.id,
                authorId: message.author.id,
                ruleType,
            },
        },
    }).catch((error) => {
        logger.error('[AutoMod] Failed to write mod-log entry:', error);
    });

    return true;
}

/**
 * Entry point called from messageCreate for every guild message — deliberately
 * run BEFORE sticky/counting-game handling. Cheap no-op for channels without
 * a configured rule since it only ever reads the in-memory cache.
 *
 * @returns {Promise<boolean>} true if the message was deleted, so the caller
 * can skip running any further handlers against it.
 */
export async function handleAutoModMessage(message, client) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system) {
        return false;
    }

    const rule = getCachedRule(message.channel.id);
    if (!rule) return false;

    if (isIgnoredMember(message.member)) return false;

    if (rule.ruleType === RULE_TYPES.AUTO_DELETE) {
        return deleteAndLog(message, client, rule.ruleType, 'Message sent in an auto-delete-only channel');
    }

    if (rule.ruleType === RULE_TYPES.VOUCH_FORMAT) {
        if (isValidVouchMessage(message.content)) return false;

        const deleted = await deleteAndLog(message, client, rule.ruleType, 'Message did not match required "Vouch @user" format');
        await sendTemporaryWarning(
            message.channel,
            `${message.author}, this channel only accepts messages in the format \`Vouch @user\`.`,
        );
        return deleted;
    }

    return false;
}

/**
 * Bulk-deletes up to `amount` recent messages in a channel (the manual
 * /automod purge command). Discord's bulkDelete caps at 100 per call and
 * refuses messages older than 14 days — both are handled transparently.
 * Returns the total number of messages actually deleted.
 */
export async function purgeChannelMessages(channel, amount) {
    let remaining = amount;
    let totalDeleted = 0;

    while (remaining > 0) {
        const batchSize = Math.min(remaining, 100);
        const deleted = await channel.bulkDelete(batchSize, true);
        totalDeleted += deleted.size;
        remaining -= batchSize;

        // bulkDelete returning fewer than requested (or zero) means there's
        // nothing left worth fetching — stop early instead of looping until
        // `amount` is exhausted against an empty channel.
        if (deleted.size < batchSize) break;
    }

    return totalDeleted;
}
