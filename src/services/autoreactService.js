// autoreactService.js
//
// Business logic for Auto-Reactions: in-memory cache of each channel's
// configured emoji list (loaded on startup, kept in sync on writes — same
// pattern as sticky/automod, so the messageCreate hot path never queries
// Postgres), emoji input parsing/validation, and the reaction hook itself.

import { logger } from '../utils/logger.js';
import * as autoreactRepository from '../utils/database/autoreact.js';

const MAX_EMOJIS_PER_CHANNEL = 20;

/** @type {Map<string, string[]>} channelId -> ordered list of emoji (unicode or custom id) */
const ruleCache = new Map();

/** Loads every autoreact rule into memory. Call once at startup. */
export async function initAutoReactCache() {
    ruleCache.clear();

    try {
        const rules = await autoreactRepository.getAllRules();
        for (const rule of rules) {
            ruleCache.set(rule.channelId, rule.emojis);
        }
        logger.info(`[AutoReact] Loaded ${rules.length} channel rule(s) into cache`);
    } catch (error) {
        logger.error('[AutoReact] Failed to warm the autoreact cache:', error);
    }

    return ruleCache.size;
}

export function getCachedEmojis(channelId) {
    return ruleCache.get(channelId) || [];
}

export async function listRules(guildId) {
    return autoreactRepository.listRulesForGuild(guildId);
}

const CUSTOM_EMOJI_PATTERN = /^<a?:\w+:(\d+)>$/;

/**
 * Parses a typed emoji into its reactable form. Custom emoji mentions
 * (`<:name:id>` / `<a:name:id>`, the text Discord inserts when you pick one
 * from the emoji picker) are reduced to their bare id, since that's what
 * message.react() and stored records both expect. Unicode emoji pass
 * through unchanged. Returns null if the input isn't recognizable as either.
 */
export function parseEmojiInput(input) {
    if (!input) return null;
    const trimmed = input.trim();

    const customMatch = CUSTOM_EMOJI_PATTERN.exec(trimmed);
    if (customMatch) return customMatch[1];

    // Reasonable heuristic for "looks like a unicode emoji": non-empty,
    // short, and not plain ASCII text (so people can't add arbitrary words).
    const isPlainAscii = /^[\x00-\x7F]+$/.test(trimmed);
    if (!isPlainAscii && trimmed.length <= 8) return trimmed;

    return null;
}

/** Adds one emoji to a channel's list. Throws if already present or the list is full. */
export async function addEmoji(guildId, channelId, emojiValue) {
    const current = getCachedEmojis(channelId);

    if (current.includes(emojiValue)) {
        throw new Error('That emoji is already configured for this channel.');
    }
    if (current.length >= MAX_EMOJIS_PER_CHANNEL) {
        throw new Error(`A channel can have at most ${MAX_EMOJIS_PER_CHANNEL} auto-react emojis.`);
    }

    const next = [...current, emojiValue];
    const rule = await autoreactRepository.setEmojis(guildId, channelId, next);
    ruleCache.set(channelId, rule.emojis);
    return rule;
}

/** Removes one emoji from a channel's list. Returns false if it wasn't configured. */
export async function removeEmoji(guildId, channelId, emojiValue) {
    const current = getCachedEmojis(channelId);
    if (!current.includes(emojiValue)) return false;

    const next = current.filter((value) => value !== emojiValue);

    if (next.length === 0) {
        await autoreactRepository.deleteRule(channelId);
        ruleCache.delete(channelId);
    } else {
        const rule = await autoreactRepository.setEmojis(guildId, channelId, next);
        ruleCache.set(channelId, rule.emojis);
    }

    return true;
}

/** Clears every emoji configured for a channel. Returns true if a rule existed. */
export async function clearChannel(channelId) {
    const removed = await autoreactRepository.deleteRule(channelId);
    ruleCache.delete(channelId);
    return removed;
}

/**
 * Entry point called from messageCreate for every guild message. Cheap
 * no-op for channels without configured emoji since it only ever reads the
 * in-memory cache. Reactions are added sequentially (not in parallel) so
 * they land on the message in the configured order.
 */
export async function handleAutoReactMessage(message) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system) {
        return;
    }

    const emojis = getCachedEmojis(message.channel.id);
    if (emojis.length === 0) return;

    for (const emoji of emojis) {
        try {
            await message.react(emoji);
        } catch (error) {
            logger.debug(`[AutoReact] Failed to react with ${emoji} in channel ${message.channel.id}: ${error.message}`);
        }
    }
}
