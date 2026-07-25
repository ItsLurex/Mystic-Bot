// stickyService.js
//
// Business logic for the Sticky Messages feature.
//
// - Owns the in-memory cache (loaded on startup, kept in sync with every
//   database write) so the messageCreate hot path never has to hit
//   PostgreSQL just to check whether a channel has a sticky.
// - Owns the per-channel Mutex lock that guarantees only one repost
//   operation ever runs per channel at a time, even under a burst of
//   simultaneous messages.
// - Owns embed rendering, since the stored embed_json must be turned into a
//   real discord.js payload every time the sticky is (re)posted.

import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { botHasPermission } from '../utils/permissionGuard.js';
import { TitanBotError, ErrorTypes, createError } from '../utils/errorHandler.js';
import * as stickyRepository from '../utils/database/stickyMessages.js';

/** Minimum threshold: reposting after every single qualifying message. */
export const MIN_THRESHOLD = 1;
/** Maximum threshold, purely a sanity guard against fat-fingered input. */
export const MAX_THRESHOLD = 500;
/** Approximate delay between deleting the old sticky and posting the new one. */
const REPOST_DELAY_MS = 1000;

/**
 * In-memory cache of sticky rows keyed by channel_id. A channel can only
 * ever have one sticky, which keeps this a flat Map instead of a nested
 * per-guild structure.
 * @type {Map<string, object>}
 */
const stickyCache = new Map();

function cacheKey(channelId) {
    return String(channelId);
}

function setCache(sticky) {
    if (!sticky) return;
    stickyCache.set(cacheKey(sticky.channelId), sticky);
}

function removeCache(channelId) {
    stickyCache.delete(cacheKey(channelId));
}

/** Read-only accessor for the cached sticky of a channel, if any. */
export function getCachedSticky(channelId) {
    return stickyCache.get(cacheKey(channelId)) || null;
}

/**
 * Load every sticky message from the database into the in-memory cache.
 * Must be called once during startup, before the bot starts processing
 * messages, per the "load all stickies on startup" requirement.
 */
export async function initializeStickyCache(client) {
    stickyCache.clear();

    try {
        const stickies = await stickyRepository.getAllStickies();
        for (const sticky of stickies) {
            setCache(sticky);
        }
        logger.info(`[Sticky] Loaded ${stickies.length} sticky message(s) into cache`);
    } catch (error) {
        logger.error('[Sticky] Failed to warm the sticky message cache:', error);
    }

    return stickyCache.size;
}

function normalizeHexColor(color) {
    if (!color) return null;
    const trimmed = String(color).trim();
    const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return /^#[0-9A-Fa-f]{6}$/.test(withHash) ? withHash.toUpperCase() : null;
}

function isValidHttpUrl(value) {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Builds the embed_json object stored in the database from raw slash-command
 * option values. Returns null when no embed-related option was provided,
 * meaning the sticky is (or stays) plain text only.
 * Throws a TitanBotError (VALIDATION) on malformed color/URL input.
 */
export function buildEmbedJsonFromOptions({
    title,
    description,
    color,
    thumbnail,
    image,
    footer,
    author,
    timestamp,
} = {}) {
    const hasAnyEmbedOption = [title, description, color, thumbnail, image, footer, author].some(
        (value) => value !== undefined && value !== null,
    ) || timestamp === true;

    if (!hasAnyEmbedOption) {
        return null;
    }

    const embedJson = {};

    if (title) embedJson.title = String(title).substring(0, 256);
    if (description) embedJson.description = String(description).substring(0, 4096);

    if (color) {
        const normalized = normalizeHexColor(color);
        if (!normalized) {
            throw createError(
                'Invalid embed color',
                ErrorTypes.VALIDATION,
                'Please provide a valid hex color, e.g. `#5865F2`.',
                { field: 'color', value: color },
            );
        }
        embedJson.color = normalized;
    }

    if (thumbnail) {
        if (!isValidHttpUrl(thumbnail)) {
            throw createError(
                'Invalid thumbnail URL',
                ErrorTypes.VALIDATION,
                'The thumbnail must be a valid http(s) URL.',
                { field: 'thumbnail', value: thumbnail },
            );
        }
        embedJson.thumbnail = thumbnail;
    }

    if (image) {
        if (!isValidHttpUrl(image)) {
            throw createError(
                'Invalid image URL',
                ErrorTypes.VALIDATION,
                'The image must be a valid http(s) URL.',
                { field: 'image', value: image },
            );
        }
        embedJson.image = image;
    }

    if (footer) embedJson.footer = String(footer).substring(0, 2048);
    if (author) embedJson.author = String(author).substring(0, 256);
    if (timestamp === true) embedJson.timestamp = true;

    return embedJson;
}

/**
 * Merges partial embed option updates from /sticky edit into an existing
 * embed_json object. A null value for a field explicitly clears that field.
 */
export function mergeEmbedJsonOptions(existingEmbedJson, options = {}) {
    const base = existingEmbedJson ? { ...existingEmbedJson } : {};
    const incoming = buildEmbedJsonFromOptions(options) || {};

    const merged = { ...base, ...incoming };

    // Explicit clears: an option passed as an empty string clears the field.
    for (const field of ['title', 'description', 'color', 'thumbnail', 'image', 'footer', 'author']) {
        if (options[field] === '') {
            delete merged[field];
        }
    }
    if (options.timestamp === false) {
        delete merged.timestamp;
    }

    return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Converts a stored embed_json object into a real discord.js EmbedBuilder.
 * Built via the raw-data constructor (not the fluent setters) so it is
 * unaffected by the project-wide EmbedBuilder.prototype patches that mute
 * setFooter()/setTimestamp() for non-"important" text (see utils/embeds.js) —
 * a sticky's footer/timestamp is user-authored content, not a system notice,
 * so it must render exactly as configured.
 */
export function renderStickyEmbed(embedJson) {
    if (!embedJson || typeof embedJson !== 'object') {
        return null;
    }

    const data = {};
    if (embedJson.title) data.title = embedJson.title;
    if (embedJson.description) data.description = embedJson.description;
    if (embedJson.color) {
        const normalized = normalizeHexColor(embedJson.color);
        if (normalized) data.color = parseInt(normalized.slice(1), 16);
    }
    if (embedJson.thumbnail) data.thumbnail = { url: embedJson.thumbnail };
    if (embedJson.image) data.image = { url: embedJson.image };
    if (embedJson.footer) data.footer = { text: embedJson.footer };
    if (embedJson.author) data.author = { name: embedJson.author };
    if (embedJson.timestamp) data.timestamp = new Date().toISOString();

    if (Object.keys(data).length === 0) {
        return null;
    }

    return new EmbedBuilder(data);
}

/** Builds the { content, embeds } payload used to post/repost a sticky. */
export function renderStickyPayload(sticky) {
    const embed = renderStickyEmbed(sticky.embedJson);
    const payload = {};

    if (sticky.messageContent) {
        payload.content = sticky.messageContent;
    }
    if (embed) {
        payload.embeds = [embed];
    }

    return payload;
}

function assertThreshold(threshold) {
    const value = Number(threshold);
    if (!Number.isInteger(value) || value < MIN_THRESHOLD || value > MAX_THRESHOLD) {
        throw createError(
            'Invalid sticky threshold',
            ErrorTypes.VALIDATION,
            `Threshold must be a whole number between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}.`,
            { field: 'threshold', value: threshold },
        );
    }
    return value;
}

/**
 * Create a new sticky for a channel and post it immediately.
 * Throws TitanBotError(VALIDATION) if the channel already has a sticky, if
 * neither content nor embed content was supplied, or if the bot is missing
 * the permissions needed to post in the channel.
 */
export async function createStickyForChannel({ guild, channel, messageContent, embedJson, threshold = 1 }) {
    if (getCachedSticky(channel.id)) {
        throw createError(
            'Sticky already exists for this channel',
            ErrorTypes.VALIDATION,
            `<#${channel.id}> already has a sticky message. Use \`/sticky edit\` to change it or \`/sticky remove\` first.`,
            { channelId: channel.id },
        );
    }

    if (!messageContent && !embedJson) {
        throw createError(
            'Sticky requires content or an embed',
            ErrorTypes.VALIDATION,
            'Provide message content and/or at least one embed option (title, description, etc).',
            { channelId: channel.id },
        );
    }

    if (!ensureBotCanPostIn(channel)) {
        throw createError(
            'Bot missing permissions to post sticky',
            ErrorTypes.PERMISSION,
            `I need **View Channel**, **Send Messages**, and **Embed Links** permissions in <#${channel.id}> to set up a sticky there.`,
            { channelId: channel.id },
        );
    }

    const validThreshold = assertThreshold(threshold);

    const created = await stickyRepository.createSticky({
        guildId: guild.id,
        channelId: channel.id,
        messageContent: messageContent || null,
        embedJson: embedJson || null,
        threshold: validThreshold,
    });

    setCache(created);

    const message = await channel.send(renderStickyPayload(created));
    const updated = await stickyRepository.updateSticky(guild.id, channel.id, {
        lastMessageId: message.id,
    });
    setCache(updated);

    return updated;
}

/**
 * Update an existing sticky's content/embed/threshold/enabled state without
 * deleting the database row. Does not repost immediately — the new content
 * appears the next time the threshold is reached (or via /sticky resume
 * behavior if desired). Throws if no sticky exists for the channel.
 */
export async function updateStickyForChannel(guild, channel, updates = {}) {
    const existing = getCachedSticky(channel.id) || await stickyRepository.getStickyByChannel(guild.id, channel.id);
    if (!existing) {
        throw createError(
            'No sticky configured for this channel',
            ErrorTypes.VALIDATION,
            `<#${channel.id}> does not have a sticky message. Use \`/sticky set\` to create one.`,
            { channelId: channel.id },
        );
    }

    const patch = {};

    if (updates.messageContent !== undefined) {
        patch.messageContent = updates.messageContent === '' ? null : updates.messageContent;
    }

    if (updates.embedOptionsProvided) {
        const mergedEmbed = mergeEmbedJsonOptions(existing.embedJson, updates.embedOptions);
        patch.embedJson = mergedEmbed;
    }

    if (updates.threshold !== undefined) {
        patch.threshold = assertThreshold(updates.threshold);
    }

    if (updates.enabled !== undefined) {
        patch.enabled = Boolean(updates.enabled);
    }

    const nextMessageContent = patch.messageContent !== undefined ? patch.messageContent : existing.messageContent;
    const nextEmbedJson = patch.embedJson !== undefined ? patch.embedJson : existing.embedJson;
    if (!nextMessageContent && !nextEmbedJson) {
        throw createError(
            'Sticky requires content or an embed',
            ErrorTypes.VALIDATION,
            'A sticky cannot be left with no content and no embed. Provide at least one.',
            { channelId: channel.id },
        );
    }

    if (Object.keys(patch).length === 0) {
        return existing;
    }

    const updated = await stickyRepository.updateSticky(guild.id, channel.id, patch);
    setCache(updated);
    return updated;
}

/**
 * Delete a sticky's database row and, if it still exists, its live message.
 */
export async function deleteStickyForChannel(guild, channel) {
    const existing = getCachedSticky(channel.id) || await stickyRepository.getStickyByChannel(guild.id, channel.id);
    if (!existing) {
        throw createError(
            'No sticky configured for this channel',
            ErrorTypes.VALIDATION,
            `<#${channel.id}> does not have a sticky message to remove.`,
            { channelId: channel.id },
        );
    }

    if (existing.lastMessageId) {
        await channel.messages.delete(existing.lastMessageId).catch((error) => {
            logger.debug(`[Sticky] Could not delete existing sticky message ${existing.lastMessageId}: ${error.message}`);
        });
    }

    await stickyRepository.deleteSticky(guild.id, channel.id);
    removeCache(channel.id);

    return existing;
}

async function setEnabledForChannel(guild, channel, enabled) {
    const existing = getCachedSticky(channel.id) || await stickyRepository.getStickyByChannel(guild.id, channel.id);
    if (!existing) {
        throw createError(
            'No sticky configured for this channel',
            ErrorTypes.VALIDATION,
            `<#${channel.id}> does not have a sticky message. Use \`/sticky set\` to create one.`,
            { channelId: channel.id },
        );
    }

    if (existing.enabled === enabled) {
        return existing;
    }

    const updated = await stickyRepository.updateSticky(guild.id, channel.id, { enabled });
    setCache(updated);
    return updated;
}

/** Temporarily disable reposting for a channel's sticky without deleting it. */
export async function pauseStickyForChannel(guild, channel) {
    return setEnabledForChannel(guild, channel, false);
}

/** Re-enable reposting for a channel's sticky. */
export async function resumeStickyForChannel(guild, channel) {
    return setEnabledForChannel(guild, channel, true);
}

/** List every sticky configured in a guild (used by /sticky list). */
export async function listStickies(guildId) {
    return stickyRepository.listStickiesForGuild(guildId);
}

function ensureBotCanPostIn(channel) {
    return botHasPermission(channel, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
    ]);
}

/**
 * Whether a message should ever be considered for sticky reposting:
 * excludes bots, webhooks, and system messages, and requires the channel to
 * actually have an enabled sticky.
 */
function isQualifyingMessage(message) {
    if (!message.guild) return false;
    if (message.author?.bot) return false;
    if (message.webhookId) return false;
    if (message.system) return false;
    return true;
}

/**
 * Repost a sticky: delete the previous message (if it still exists), wait
 * ~1s, then send the sticky fresh so it lands at the bottom of the channel.
 * Persists the new message id and resets the counter. Never throws —
 * Discord API failures (missing perms, deleted channel, rate limits) and
 * database failures are logged and swallowed, since this runs off the
 * messageCreate event rather than an interaction.
 */
async function repostSticky(client, sticky) {
    const channel = client.channels.cache.get(sticky.channelId)
        || await client.channels.fetch(sticky.channelId).catch(() => null);

    if (!channel) {
        logger.warn(`[Sticky] Channel ${sticky.channelId} no longer exists; disabling its sticky.`);
        await stickyRepository.updateSticky(sticky.guildId, sticky.channelId, { enabled: false }).catch(() => {});
        removeCache(sticky.channelId);
        return;
    }

    if (!ensureBotCanPostIn(channel)) {
        logger.warn(`[Sticky] Missing permissions to repost sticky in channel ${sticky.channelId} (guild ${sticky.guildId}).`);
        return;
    }

    if (sticky.lastMessageId) {
        await channel.messages.delete(sticky.lastMessageId).catch((error) => {
            logger.debug(`[Sticky] Previous sticky message ${sticky.lastMessageId} already gone: ${error.message}`);
        });
    }

    await new Promise((resolve) => setTimeout(resolve, REPOST_DELAY_MS));

    let newMessage;
    try {
        newMessage = await channel.send(renderStickyPayload(sticky));
    } catch (error) {
        logger.error(`[Sticky] Failed to repost sticky in channel ${sticky.channelId} (guild ${sticky.guildId}):`, error);
        return;
    }

    try {
        const updated = await stickyRepository.updateSticky(sticky.guildId, sticky.channelId, {
            lastMessageId: newMessage.id,
            messageCounter: 0,
        });
        setCache(updated);
    } catch (error) {
        logger.error(`[Sticky] Reposted sticky but failed to persist new state for channel ${sticky.channelId}:`, error);
        // Keep the cache reasonably correct even if the DB write failed.
        setCache({ ...sticky, lastMessageId: newMessage.id, messageCounter: 0 });
    }
}

/**
 * Entry point called from the messageCreate event for every guild message.
 * Cheap no-op for the overwhelming majority of messages (channels without a
 * sticky, or bot/webhook/system messages) since it only ever reads the
 * in-memory cache — never PostgreSQL — until a repost is actually due.
 */
export async function handleMessageForSticky(message, client) {
    if (!isQualifyingMessage(message)) {
        return;
    }

    const sticky = getCachedSticky(message.channel.id);
    if (!sticky || !sticky.enabled) {
        return;
    }

    // Only one repost/counter-update may run per channel at a time, even if
    // several messages arrive back-to-back before the previous one settles.
    await Mutex.runExclusive(`sticky:${message.channel.id}`, async () => {
        const current = getCachedSticky(message.channel.id);
        if (!current || !current.enabled) {
            return;
        }

        const nextCounter = current.messageCounter + 1;

        if (nextCounter < current.threshold) {
            const bumped = { ...current, messageCounter: nextCounter };
            setCache(bumped);
            try {
                await stickyRepository.updateSticky(current.guildId, current.channelId, {
                    messageCounter: nextCounter,
                });
            } catch (error) {
                logger.error(`[Sticky] Failed to persist counter for channel ${current.channelId}:`, error);
            }
            return;
        }

        await repostSticky(client, current);
    }).catch((error) => {
        logger.error(`[Sticky] Unexpected error while processing message for channel ${message.channel.id}:`, error);
    });
}

export default {
    MIN_THRESHOLD,
    MAX_THRESHOLD,
    initializeStickyCache,
    getCachedSticky,
    buildEmbedJsonFromOptions,
    mergeEmbedJsonOptions,
    renderStickyEmbed,
    renderStickyPayload,
    createStickyForChannel,
    updateStickyForChannel,
    deleteStickyForChannel,
    pauseStickyForChannel,
    resumeStickyForChannel,
    listStickies,
    handleMessageForSticky,
};
