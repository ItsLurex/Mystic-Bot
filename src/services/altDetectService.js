// altDetectService.js
//
// Business logic for the Alt Detector feature: an in-memory cache of per-guild
// configs (warmed at startup, kept in sync on writes), the join-time check
// that applies the configured action to accounts younger than the threshold,
// the on-demand guild scan, and the guildBanAdd bookkeeping that keeps flag
// records accurate when a flagged alt ends up banned.
//
// Config and flag persistence lives in src/utils/database/altDetect.js.

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getColor } from '../config/bot.js';
import { ModerationService } from './moderation/moderationService.js';
import * as altDetectRepository from '../utils/database/altDetect.js';

export const ALT_DETECT_ACTIONS = altDetectRepository.ALT_DETECT_ACTIONS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** @type {Map<string, object>} guildId -> config */
const configCache = new Map();
let cacheLoaded = false;
let cacheLoadPromise = null;

/** Loads every guild's alt-detect config into memory. Call once at startup. */
export async function initAltDetectCache() {
    configCache.clear();

    try {
        const configs = await altDetectRepository.getAllConfigs();
        for (const config of configs) {
            configCache.set(config.guildId, config);
        }
        cacheLoaded = true;
        logger.info(`[AltDetect] Loaded ${configs.length} guild config(s) into cache`);
    } catch (error) {
        logger.error('[AltDetect] Failed to warm the config cache:', error);
    }

    return configCache.size;
}

async function ensureCacheLoaded() {
    if (cacheLoaded) return;
    if (!cacheLoadPromise) {
        cacheLoadPromise = initAltDetectCache().finally(() => {
            cacheLoadPromise = null;
        });
    }
    await cacheLoadPromise;
}

/** Returns the (possibly default) config for a guild. */
export async function getConfig(guildId) {
    await ensureCacheLoaded();

    const cached = configCache.get(guildId);
    if (cached) return cached;

    const config = await altDetectRepository.getConfig(guildId);
    configCache.set(guildId, config);
    return config;
}

/** Persists a config and refreshes the cache. */
export async function saveConfig(config) {
    const saved = await altDetectRepository.saveConfig(config);
    configCache.set(saved.guildId, saved);
    return saved;
}

/** Account age in (fractional) days. */
export function getAccountAgeDays(user) {
    if (!user?.createdAt) return null;
    return (Date.now() - user.createdAt.getTime()) / MS_PER_DAY;
}

/** True if the member holds any of the guild's exempt roles. */
export function isExemptMember(member, config) {
    if (!member || !Array.isArray(config?.exemptRoleIds) || config.exemptRoleIds.length === 0) {
        return false;
    }
    return config.exemptRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function resolveAlertChannel(guild, config) {
    if (!config?.alertChannelId) return null;

    const channel = guild.channels.cache.get(config.alertChannelId)
        || await guild.channels.fetch(config.alertChannelId).catch(() => null);

    if (!channel?.isTextBased?.()) return null;

    const permissions = guild.members.me?.permissionsIn?.(channel);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return null;
    }

    return channel;
}

async function sendAlert(guild, config, embed) {
    try {
        const channel = await resolveAlertChannel(guild, config);
        if (!channel) return null;
        return await channel.send({ embeds: [embed] });
    } catch (error) {
        logger.error(`[AltDetect] Failed to send alert in guild ${guild.id}:`, error);
        return null;
    }
}

async function dmUserSafely(user, content) {
    try {
        await user.send(content);
        return true;
    } catch {
        // Closed DMs / bots — nothing to do.
        return false;
    }
}

function buildFlagEmbed({ title, color, user, ageDays, thresholdDays, guild, detail }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(getColor(color))
        .setThumbnail(user?.displayAvatarURL?.() ?? null)
        .addFields(
            { name: 'User', value: user ? `<@${user.id}> (${user.tag ?? user.id})` : 'Unknown', inline: true },
            {
                name: 'Account age',
                value: ageDays == null
                    ? 'Unknown'
                    : `${Math.floor(ageDays)} day(s) (threshold: ${thresholdDays})`,
                inline: true,
            },
        )
        .setTimestamp();

    if (user?.createdAt) {
        embed.addFields({ name: 'Account created', value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:F>`, inline: true });
    }
    if (detail) {
        embed.addFields({ name: 'Details', value: detail });
    }
    embed.setFooter({ text: `Alt Detector • ${guild.name}` });
    return embed;
}

async function applyAction({ member, config, ageDays, source }) {
    const { guild, user } = member;
    const me = guild.members.me;
    const thresholdDays = config.minAccountAgeDays;
    const action = config.action || 'alert';

    const dmMessage = config.dmUser
        ? `Your account in **${guild.name}** is younger than the server's minimum of ${thresholdDays} day(s) for new members.`
        : null;

    let status = 'alerted';
    let detail = 'Logged for staff review — no action taken.';

    if (action === 'kick' && member.kickable) {
        try {
            if (dmMessage) await dmUserSafely(user, `${dmMessage} You have been kicked.`);
            await ModerationService.kickUser({
                guild,
                member,
                moderator: guild.members.me,
                reason: `Alt Detector: account younger than ${thresholdDays} day(s)`,
            });
            status = 'kicked';
            detail = 'Kicked on join — account below the minimum age.';
        } catch (error) {
            logger.error(`[AltDetect] Kick failed for ${user.id} in guild ${guild.id}:`, error);
            detail = `Kick configured but failed (${error?.message ?? 'unknown error'}) — logged for staff review instead.`;
        }
    } else if (action === 'ban') {
        try {
            await ModerationService.banUser({
                guild,
                user,
                moderator: guild.members.me,
                reason: `Alt Detector: account younger than ${thresholdDays} day(s)`,
                deleteDays: 0,
                notify: Boolean(dmMessage),
                dmMessage: dmMessage ? `${dmMessage} You have been banned.` : null,
            });
            status = 'banned';
            detail = 'Banned on join — account below the minimum age.';
        } catch (error) {
            logger.error(`[AltDetect] Ban failed for ${user.id} in guild ${guild.id}:`, error);
            detail = `Ban configured but failed (${error?.message ?? 'unknown error'}) — logged for staff review instead.`;
        }
    } else if (action === 'kick' && !member.kickable) {
        detail = 'Kick configured but the member is not kickable — logged for staff review instead.';
    }

    const flag = await altDetectRepository.upsertFlag({
        guildId: guild.id,
        userId: user.id,
        userTag: user.tag ?? user.username ?? null,
        accountCreatedAt: user.createdAt,
        accountAgeDays: ageDays == null ? null : Math.floor(ageDays),
        source,
        status,
        notes: detail,
    });

    const title = status === 'banned'
        ? '🔨 Alt Detector: new account banned'
        : status === 'kicked'
            ? '👢 Alt Detector: new account kicked'
            : '🕵️ Alt Detector: suspected alt account';

    await sendAlert(guild, config, buildFlagEmbed({
        title,
        color: status === 'banned' ? 'error' : status === 'kicked' ? 'warning' : 'info',
        user,
        ageDays,
        thresholdDays,
        guild,
        detail,
    }));

    logger.info(`[AltDetect] ${user.id} in guild ${guild.id}: account age ${ageDays?.toFixed(1)}d < ${thresholdDays}d → ${status} (source: ${source})`);
    return flag;
}

/**
 * Join-time check, called from the guildMemberAdd event.
 *
 * @returns {Promise<boolean>} true if the member was kicked or banned, so the
 * caller can skip the rest of the join pipeline (welcome message, auto-role,
 * counters...) for a member that no longer exists.
 */
export async function handleMemberJoin(member) {
    try {
        if (!member?.guild || member.user?.bot) return false;

        const config = await getConfig(member.guild.id);
        if (!config.enabled) return false;

        // Staff-approved accounts are never touched by the detector.
        const existingFlag = await altDetectRepository.getFlag(member.guild.id, member.user.id);
        if (existingFlag?.status === 'cleared') return false;
        if (isExemptMember(member, config)) return false;

        const ageDays = getAccountAgeDays(member.user);

        // Previously banned as a flagged alt? Alert staff about the rejoin but
        // don't punish again automatically — ban evasion stays a human call.
        if (existingFlag?.status === 'banned') {
            await sendAlert(member.guild, config, buildFlagEmbed({
                title: '⚠️ Alt Detector: previously banned account rejoined',
                color: 'warning',
                user: member.user,
                ageDays,
                thresholdDays: config.minAccountAgeDays,
                guild: member.guild,
                detail: `This user was banned as a suspected alt on <t:${Math.floor((existingFlag.resolvedAt ?? existingFlag.flaggedAt ?? new Date()).getTime() / 1000)}:F>. Review their new membership.`,
            }));
            return false;
        }

        if (ageDays == null || ageDays >= config.minAccountAgeDays) return false;

        const flag = await applyAction({ member, config, ageDays, source: 'join' });
        return flag?.status === 'kicked' || flag?.status === 'banned';
    } catch (error) {
        logger.error(`[AltDetect] handleMemberJoin failed for ${member?.user?.id} in guild ${member?.guild?.id}:`, error);
        return false;
    }
}

/**
 * Scans every cached member of a guild and flags accounts younger than the
 * configured threshold. Report-only — the scan never kicks or bans anyone.
 *
 * @returns {Promise<{scanned: number, flagged: object[], skippedCleared: number}>}
 */
export async function scanGuild(guild) {
    const config = await getConfig(guild.id);

    let members = guild.members.cache;
    try {
        members = await guild.members.fetch();
    } catch (error) {
        logger.warn(`[AltDetect] Full member fetch failed for guild ${guild.id}, using cache:`, error.message);
    }

    let scanned = 0;
    let skippedCleared = 0;
    const flagged = [];

    for (const member of members.values()) {
        if (member.user.bot) continue;
        scanned += 1;

        const ageDays = getAccountAgeDays(member.user);
        if (ageDays == null || ageDays >= config.minAccountAgeDays) continue;

        const existing = await altDetectRepository.getFlag(guild.id, member.user.id);
        if (existing?.status === 'cleared') {
            skippedCleared += 1;
            continue;
        }

        const flag = await altDetectRepository.upsertFlag({
            guildId: guild.id,
            userId: member.user.id,
            userTag: member.user.tag ?? member.user.username ?? null,
            accountCreatedAt: member.user.createdAt,
            accountAgeDays: Math.floor(ageDays),
            source: existing?.source === 'join' ? 'join' : 'scan',
            status: existing && existing.status !== 'flagged' ? existing.status : 'flagged',
            notes: existing?.notes ?? 'Flagged by manual scan.',
        });

        flagged.push({ member, flag, ageDays });
    }

    return { scanned, flagged, skippedCleared, config };
}

/**
 * guildBanAdd hook: whenever someone is banned, keep their flag record honest.
 * Flagged alts that got banned (by staff or by the detector itself) move to
 * the terminal 'banned' status with the ban's audit reason attached.
 */
export async function handleGuildBanAdd(ban) {
    try {
        const { guild, user } = ban;
        if (!guild || !user) return;

        const existing = await altDetectRepository.getFlag(guild.id, user.id);
        if (!existing) return;
        if (existing.status === 'banned') return;

        let auditReason = null;
        try {
            const fetched = await guild.bans.fetch(user.id);
            auditReason = fetched?.reason || null;
        } catch {
            // Ban entry not fetchable (permissions/race) — proceed without it.
        }

        const notes = auditReason
            ? `Banned: ${auditReason}`
            : 'Banned while flagged as a suspected alt account.';

        await altDetectRepository.upsertFlag({
            guildId: guild.id,
            userId: user.id,
            userTag: user.tag ?? user.username ?? null,
            accountCreatedAt: existing.accountCreatedAt ?? user.createdAt ?? null,
            accountAgeDays: existing.accountAgeDays,
            source: existing.source,
            status: 'banned',
            notes,
        });

        const config = await getConfig(guild.id);
        if (config.enabled) {
            await sendAlert(guild, config, buildFlagEmbed({
                title: '🔨 Alt Detector: flagged account banned',
                color: 'error',
                user,
                ageDays: existing.accountAgeDays,
                thresholdDays: config.minAccountAgeDays,
                guild,
                detail: auditReason ? `Ban reason: ${auditReason}` : 'Flagged alt account has been banned.',
            }));
        }

        logger.info(`[AltDetect] Flagged user ${user.id} banned in guild ${guild.id}; flag updated`);
    } catch (error) {
        logger.error(`[AltDetect] handleGuildBanAdd failed for ${ban?.user?.id} in guild ${ban?.guild?.id}:`, error);
    }
}

/** Clears a flag (marks it reviewed/approved) instead of deleting history. */
export async function clearFlag(guildId, userId) {
    const existing = await altDetectRepository.getFlag(guildId, userId);
    if (!existing) return false;

    await altDetectRepository.upsertFlag({
        guildId,
        userId,
        source: existing.source,
        status: 'cleared',
        notes: 'Cleared by staff — account approved.',
    });
    return true;
}

/** Deletes a flag record entirely. Returns true if one existed. */
export async function removeFlag(guildId, userId) {
    return altDetectRepository.removeFlag(guildId, userId);
}

export async function listFlags(guildId) {
    return altDetectRepository.listFlags(guildId);
}
