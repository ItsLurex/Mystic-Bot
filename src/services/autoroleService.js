// autoroleService.js
//
// Business logic for Auto-Roles: in-memory cache of each guild's configured
// member/bot roles (loaded on startup, kept in sync on writes), and the
// guildMemberAdd hook that actually assigns the role.

import { logger } from '../utils/logger.js';
import * as autoroleRepository from '../utils/database/autoroleConfig.js';

/** @type {Map<string, {memberRoleId: string|null, botRoleId: string|null}>} */
const configCache = new Map();

/** Loads every guild's autorole config into memory. Call once at startup. */
export async function initAutoroleCache() {
    configCache.clear();

    try {
        const configs = await autoroleRepository.getAllAutoroleConfigs();
        for (const config of configs) {
            configCache.set(config.guildId, {
                memberRoleId: config.memberRoleId,
                botRoleId: config.botRoleId,
            });
        }
        logger.info(`[Autorole] Loaded autorole config for ${configs.length} guild(s)`);
    } catch (error) {
        logger.error('[Autorole] Failed to warm the autorole config cache:', error);
    }

    return configCache.size;
}

export function getCachedAutoroleConfig(guildId) {
    return configCache.get(guildId) || { memberRoleId: null, botRoleId: null };
}

export async function setMemberAutorole(guildId, roleId) {
    const updated = await autoroleRepository.setAutoroleConfig(guildId, { memberRoleId: roleId });
    configCache.set(guildId, { memberRoleId: updated.memberRoleId, botRoleId: updated.botRoleId });
    return updated;
}

export async function setBotAutorole(guildId, roleId) {
    const updated = await autoroleRepository.setAutoroleConfig(guildId, { botRoleId: roleId });
    configCache.set(guildId, { memberRoleId: updated.memberRoleId, botRoleId: updated.botRoleId });
    return updated;
}

export async function clearMemberAutorole(guildId) {
    return setMemberAutorole(guildId, null);
}

export async function clearBotAutorole(guildId) {
    return setBotAutorole(guildId, null);
}

/**
 * Assigns the configured member/bot role to a newly-joined member, if one
 * is set for their guild. Never throws — a misconfigured role (deleted,
 * too high in the hierarchy, missing permission) is logged and skipped so
 * it never breaks the rest of the join pipeline (welcome message, counters,
 * etc. in guildMemberAdd).
 */
export async function applyAutoRole(member) {
    const config = getCachedAutoroleConfig(member.guild.id);
    const roleId = member.user.bot ? config.botRoleId : config.memberRoleId;

    if (!roleId) return;

    const role = member.guild.roles.cache.get(roleId);
    if (!role) {
        logger.warn(`[Autorole] Configured role ${roleId} no longer exists in guild ${member.guild.id}`);
        return;
    }

    const botMember = member.guild.members.me;
    if (!botMember?.permissions.has('ManageRoles') || botMember.roles.highest.position <= role.position) {
        logger.warn(`[Autorole] Cannot assign role ${role.id} in guild ${member.guild.id} — missing permission or role is above the bot's highest role`);
        return;
    }

    try {
        await member.roles.add(role, 'Auto-role on join');
    } catch (error) {
        logger.error(`[Autorole] Failed to assign role ${role.id} to ${member.id} in guild ${member.guild.id}:`, error);
    }
}
