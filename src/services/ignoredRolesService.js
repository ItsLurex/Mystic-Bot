// ignoredRolesService.js
//
// In-memory cache for each guild's "ignored roles" list, so Auto-Moderation
// and the Invite Tracker never have to hit the database to check whether a
// member is staff/owner-exempt. Loaded on startup, kept in sync on writes.

import { logger } from '../utils/logger.js';
import { PermissionFlagsBits } from 'discord.js';
import * as ignoredRolesRepository from '../utils/database/ignoredRoles.js';

/** @type {Map<string, Set<string>>} guildId -> Set of ignored role ids */
const ignoredRolesCache = new Map();

/** Loads every guild's ignored-roles list into memory. Call once at startup. */
export async function initIgnoredRolesCache(client) {
    ignoredRolesCache.clear();

    try {
        for (const guild of client.guilds.cache.values()) {
            const roles = await ignoredRolesRepository.getIgnoredRoles(guild.id);
            ignoredRolesCache.set(guild.id, new Set(roles));
        }
        logger.info(`[IgnoredRoles] Loaded ignored-role lists for ${ignoredRolesCache.size} guild(s)`);
    } catch (error) {
        logger.error('[IgnoredRoles] Failed to warm the ignored-roles cache:', error);
    }
}

function getGuildSet(guildId) {
    if (!ignoredRolesCache.has(guildId)) {
        ignoredRolesCache.set(guildId, new Set());
    }
    return ignoredRolesCache.get(guildId);
}

export function getIgnoredRoleIds(guildId) {
    return Array.from(getGuildSet(guildId));
}

export async function addIgnoredRole(guildId, roleId) {
    await ignoredRolesRepository.addIgnoredRole(guildId, roleId);
    getGuildSet(guildId).add(roleId);
}

export async function removeIgnoredRole(guildId, roleId) {
    await ignoredRolesRepository.removeIgnoredRole(guildId, roleId);
    getGuildSet(guildId).delete(roleId);
}

/**
 * Whether a guild member should be exempt from Auto-Moderation / invite
 * tracking: either they hold an explicitly ignored role, or they have
 * Administrator / Manage Messages (staff bypass built in regardless of the
 * configured list).
 */
export function isIgnoredMember(member) {
    if (!member) return false;

    if (
        member.permissions?.has(PermissionFlagsBits.Administrator) ||
        member.permissions?.has(PermissionFlagsBits.ManageMessages)
    ) {
        return true;
    }

    const ignoredSet = getGuildSet(member.guild.id);
    if (ignoredSet.size === 0) return false;

    return member.roles.cache.some((role) => ignoredSet.has(role.id));
}
