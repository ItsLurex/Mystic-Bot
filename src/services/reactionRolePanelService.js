// reactionRolePanelService.js — cache + reaction-add/remove handling for reaction-role panels.
import { logger } from '../utils/logger.js';
import * as repo from '../utils/database/reactionRolePanels.js';

const cache = new Map(); // messageId -> { guildId, channelId, roleMap }

export async function initReactionRolePanelCache() {
    cache.clear();
    try {
        const panels = await repo.getAllPanels();
        for (const p of panels) cache.set(p.messageId, p);
        logger.info(`[ReactionRoles] Loaded ${panels.length} panel(s) into cache`);
    } catch (error) {
        logger.error('[ReactionRoles] Failed to warm cache:', error);
    }
    return cache.size;
}

export function getCachedPanel(messageId) {
    return cache.get(messageId) || null;
}

export async function createPanel(guildId, channelId, messageId) {
    const panel = await repo.createPanel({ guildId, channelId, messageId });
    cache.set(messageId, panel);
    return panel;
}

export async function addRoleMapping(messageId, emojiKey, roleId) {
    const panel = await repo.setRoleMapping(messageId, emojiKey, roleId);
    if (panel) cache.set(messageId, panel);
    return panel;
}

export async function removeRoleMapping(messageId, emojiKey) {
    const panel = await repo.removeRoleMapping(messageId, emojiKey);
    if (panel) cache.set(messageId, panel);
    return panel;
}

export async function deletePanel(messageId) {
    const removed = await repo.deletePanel(messageId);
    cache.delete(messageId);
    return removed;
}

function emojiKeyOf(emoji) {
    return emoji.id || emoji.name;
}

async function resolveMember(reaction, user) {
    if (user.bot) return null;
    const panel = getCachedPanel(reaction.message.id);
    if (!panel) return null;
    const key = emojiKeyOf(reaction.emoji);
    const roleId = panel.roleMap[key];
    if (!roleId) return null;
    const guild = reaction.message.guild;
    if (!guild) return null;
    const member = await guild.members.fetch(user.id).catch(() => null);
    return member ? { member, roleId } : null;
}

export async function handleReactionAdd(reaction, user) {
    try {
        if (reaction.partial) await reaction.fetch().catch(() => {});
        const resolved = await resolveMember(reaction, user);
        if (!resolved) return;
        const role = resolved.member.guild.roles.cache.get(resolved.roleId);
        if (!role) return;
        await resolved.member.roles.add(role, 'Reaction role').catch((error) => {
            logger.debug(`[ReactionRoles] Could not add role ${resolved.roleId} to ${user.id}: ${error.message}`);
        });
    } catch (error) {
        logger.error('[ReactionRoles] Error handling reaction add:', error);
    }
}

export async function handleReactionRemove(reaction, user) {
    try {
        if (reaction.partial) await reaction.fetch().catch(() => {});
        const resolved = await resolveMember(reaction, user);
        if (!resolved) return;
        const role = resolved.member.guild.roles.cache.get(resolved.roleId);
        if (!role) return;
        await resolved.member.roles.remove(role, 'Reaction role removed').catch((error) => {
            logger.debug(`[ReactionRoles] Could not remove role ${resolved.roleId} from ${user.id}: ${error.message}`);
        });
    } catch (error) {
        logger.error('[ReactionRoles] Error handling reaction remove:', error);
    }
}
