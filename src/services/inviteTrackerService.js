// inviteTrackerService.js
//
// Business logic for the Invite Tracker: an in-memory snapshot of every
// invite's use-count per guild (so we never have to guess without data to
// diff against), the join-detection algorithm itself, the new-account
// "fake" heuristic, and leave tracking.
//
// How "which invite was used" is detected: Discord doesn't tell you which
// invite a new member used. The standard technique (used by every invite
// tracker bot) is: keep a snapshot of every invite's use-count, and when
// someone joins, fetch the guild's invites again and see whose count went
// up. Same idea for the vanity URL, tracked separately since it isn't a
// normal invite object.

import { logger } from '../utils/logger.js';
import { isIgnoredMember } from './ignoredRolesService.js';
import * as inviteRepository from '../utils/database/inviteTracking.js';

/** New accounts joining within this many days of creation are flagged "fake". */
const FAKE_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** @type {Map<string, Map<string, {inviterId: string|null, uses: number}>>} guildId -> code -> info */
const inviteCache = new Map();

/** @type {Map<string, number>} guildId -> last known vanity URL use count */
const vanityUsesCache = new Map();

function getGuildInviteMap(guildId) {
    if (!inviteCache.has(guildId)) {
        inviteCache.set(guildId, new Map());
    }
    return inviteCache.get(guildId);
}

/**
 * Fetches a guild's current invites from Discord and rebuilds the cache
 * entry for it from scratch. Safe to call any time (startup, inviteCreate/
 * Delete, or just to resync) — never throws, since the bot may be missing
 * Manage Guild permission in some guilds.
 */
async function refreshGuildCache(guild) {
    const map = new Map();

    try {
        const invites = await guild.invites.fetch();
        for (const invite of invites.values()) {
            map.set(invite.code, {
                inviterId: invite.inviter?.id ?? null,
                uses: invite.uses ?? 0,
            });
        }
    } catch (error) {
        logger.debug(`[InviteTracker] Could not fetch invites for guild ${guild.id} (likely missing Manage Guild): ${error.message}`);
    }

    inviteCache.set(guild.id, map);

    if (guild.vanityURLCode) {
        try {
            const vanity = await guild.fetchVanityData();
            vanityUsesCache.set(guild.id, vanity.uses ?? 0);
        } catch (error) {
            logger.debug(`[InviteTracker] Could not fetch vanity data for guild ${guild.id}: ${error.message}`);
        }
    }

    return map;
}

/** Loads every guild's invite snapshot into memory. Call once at startup (after login). */
export async function initInviteCache(client) {
    inviteCache.clear();
    vanityUsesCache.clear();

    let guildCount = 0;
    for (const guild of client.guilds.cache.values()) {
        await refreshGuildCache(guild);
        guildCount += 1;
    }

    logger.info(`[InviteTracker] Loaded invite snapshots for ${guildCount} guild(s)`);
    return guildCount;
}

/** Called from the inviteCreate event to keep the cache in sync without a full refetch. */
export function cacheNewInvite(invite) {
    const map = getGuildInviteMap(invite.guild.id);
    map.set(invite.code, {
        inviterId: invite.inviter?.id ?? null,
        uses: invite.uses ?? 0,
    });
}

/** Called from the inviteDelete event to keep the cache in sync. */
export function uncacheDeletedInvite(invite) {
    const map = getGuildInviteMap(invite.guild.id);
    map.delete(invite.code);
}

/**
 * Figures out which invite a just-joined member used, by diffing a fresh
 * fetch against the last known snapshot. Returns { code, inviterId } (either
 * may be null for vanity/unattributable joins), or null if it genuinely
 * can't be determined (e.g. no Manage Guild permission, or an ambiguous
 * multi-invite race).
 */
async function resolveUsedInvite(guild) {
    const previous = getGuildInviteMap(guild.id);
    const previousVanityUses = vanityUsesCache.get(guild.id) ?? 0;

    let current;
    try {
        current = await guild.invites.fetch();
    } catch (error) {
        logger.debug(`[InviteTracker] Could not fetch invites to resolve join in guild ${guild.id}: ${error.message}`);
        return null;
    }

    // Primary signal: an invite whose use-count went up.
    const increased = [];
    for (const invite of current.values()) {
        const prevEntry = previous.get(invite.code);
        const prevUses = prevEntry?.uses ?? 0;
        if ((invite.uses ?? 0) > prevUses) {
            increased.push({ code: invite.code, inviterId: invite.inviter?.id ?? null });
        }
    }

    // Secondary signal: a single-use invite that got consumed and deleted
    // itself, so it no longer appears in the fresh fetch at all.
    const disappeared = [];
    for (const [code, entry] of previous.entries()) {
        if (!current.has(code)) {
            disappeared.push({ code, inviterId: entry.inviterId });
        }
    }

    // Refresh the cache baseline for next time, regardless of outcome.
    const nextMap = new Map();
    for (const invite of current.values()) {
        nextMap.set(invite.code, { inviterId: invite.inviter?.id ?? null, uses: invite.uses ?? 0 });
    }
    inviteCache.set(guild.id, nextMap);

    if (increased.length === 1) return increased[0];
    if (increased.length === 0 && disappeared.length === 1) return disappeared[0];

    // Vanity URL check.
    if (guild.vanityURLCode) {
        try {
            const vanity = await guild.fetchVanityData();
            vanityUsesCache.set(guild.id, vanity.uses ?? 0);
            if ((vanity.uses ?? 0) > previousVanityUses) {
                return { code: 'vanity', inviterId: null };
            }
        } catch (error) {
            logger.debug(`[InviteTracker] Could not check vanity usage for guild ${guild.id}: ${error.message}`);
        }
    }

    // Ambiguous (simultaneous joins) or genuinely undetectable (e.g. widget/Discovery join).
    return null;
}

/**
 * Entry point called from guildMemberAdd. Never throws — invite tracking
 * failing must never break the rest of the join pipeline.
 */
export async function handleMemberJoin(member) {
    if (member.user.bot) return;

    try {
        const resolved = await resolveUsedInvite(member.guild);
        if (!resolved || !resolved.inviterId) {
            // Vanity URL, or genuinely undetectable — nothing to credit.
            return;
        }

        const inviterMember = await member.guild.members.fetch(resolved.inviterId).catch(() => null);
        if (inviterMember && isIgnoredMember(inviterMember)) {
            // Staff/owner invites are intentionally not tracked.
            return;
        }

        const accountAgeMs = Date.now() - member.user.createdTimestamp;
        const status = accountAgeMs < FAKE_ACCOUNT_AGE_MS ? 'fake' : 'real';

        await inviteRepository.createJoinRecord({
            guildId: member.guild.id,
            joinedUserId: member.id,
            inviterId: resolved.inviterId,
            inviteCode: resolved.code,
            status,
        });
    } catch (error) {
        logger.error(`[InviteTracker] Error handling join for ${member.id} in guild ${member.guild.id}:`, error);
    }
}

/** Entry point called from guildMemberRemove. Never throws. */
export async function handleMemberLeave(member) {
    if (member.user.bot) return;

    try {
        await inviteRepository.markMostRecentJoinAsLeft(member.guild.id, member.id);
    } catch (error) {
        logger.error(`[InviteTracker] Error handling leave for ${member.id} in guild ${member.guild.id}:`, error);
    }
}

/** Returns { real, fake, left } counts for everyone a user has invited. */
export async function getInviteStats(guildId, userId) {
    return inviteRepository.getInviteStats(guildId, userId);
}
