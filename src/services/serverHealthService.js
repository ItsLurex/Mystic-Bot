// serverHealthService.js — live, read-only server security/config scanner.
import { PermissionFlagsBits } from 'discord.js';

const DANGEROUS_EVERYONE_CRITICAL = [
    ['Administrator', PermissionFlagsBits.Administrator],
    ['Ban Members', PermissionFlagsBits.BanMembers],
    ['Kick Members', PermissionFlagsBits.KickMembers],
    ['Manage Server', PermissionFlagsBits.ManageGuild],
    ['Manage Roles', PermissionFlagsBits.ManageRoles],
    ['Manage Webhooks', PermissionFlagsBits.ManageWebhooks],
];
const DANGEROUS_EVERYONE_WARNING = [
    ['Manage Channels', PermissionFlagsBits.ManageChannels],
    ['Manage Messages', PermissionFlagsBits.ManageMessages],
    ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
];
const STAFF_NAME_PATTERN = /staff|admin|mod(erat(or|ion))?|team|owner/i;
const TICKET_NAME_PATTERN = /ticket/i;
const INACTIVE_DAYS = 60;

function snowflakeToDate(id) {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
}

export async function scanServerHealth(guild, approvedRoleIds = []) {
    const issues = { critical: [], warning: [], info: [] };
    const everyone = guild.roles.everyone;
    const botMember = guild.members.me;
    const approvedSet = new Set(approvedRoleIds);

    for (const [label, flag] of DANGEROUS_EVERYONE_CRITICAL) {
        if (everyone.permissions.has(flag)) {
            issues.critical.push(`**@everyone has "${label}"** — every member in the server can do this. Remove it in Server Settings → Roles → @everyone.`);
        }
    }
    for (const [label, flag] of DANGEROUS_EVERYONE_WARNING) {
        if (everyone.permissions.has(flag)) {
            issues.warning.push(`**@everyone has "${label}"** — usually unintentional. Review whether every member should have this.`);
        }
    }

    const adminRoles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.permissions.has(PermissionFlagsBits.Administrator));
    for (const role of adminRoles.values()) {
        if (approvedSet.has(role.id)) continue;
        if (role.members.size === 0) {
            issues.info.push(`**${role.name}** has Administrator but 0 members hold it — not an active risk, but consider deleting it if unused.`);
        } else {
            issues.warning.push(`**${role.name}** grants full Administrator to ${role.members.size} member(s). Common for trusted staff/owners — just worth knowing that a compromised account with this role has full control.`);
        }
    }

    if (botMember.permissions.has(PermissionFlagsBits.Administrator)) {
        issues.warning.push(`**My own role has Administrator.** If my token is ever compromised, so is the whole server. Consider granting only the specific permissions I actually use.`);
    }

    for (const bot of guild.members.cache.filter((m) => m.user.bot && m.id !== botMember.id).values()) {
        if (bot.permissions.has(PermissionFlagsBits.Administrator)) {
            issues.critical.push(`**Bot "${bot.user.tag}" has Administrator.** A compromised third-party bot with this permission can fully take over the server.`);
        } else if (bot.permissions.has(PermissionFlagsBits.ManageGuild) || bot.permissions.has(PermissionFlagsBits.ManageRoles) || bot.permissions.has(PermissionFlagsBits.BanMembers)) {
            issues.warning.push(`**Bot "${bot.user.tag}" has broad moderation permissions.** Confirm it's a trusted bot you actually configured this way.`);
        }
    }

    const textChannels = guild.channels.cache.filter((c) => c.isTextBased?.() && !c.isThread?.());
    for (const channel of textChannels.values()) {
        if (STAFF_NAME_PATTERN.test(channel.name)) {
            const perms = channel.permissionsFor(everyone);
            if (perms?.has(PermissionFlagsBits.ViewChannel)) {
                issues.critical.push(`**#${channel.name} looks staff-only by name but @everyone can view it.** Add a permission overwrite denying View Channel for @everyone.`);
            }
        }
        if (TICKET_NAME_PATTERN.test(channel.name) || TICKET_NAME_PATTERN.test(channel.parent?.name || '')) {
            const perms = channel.permissionsFor(everyone);
            if (perms?.has(PermissionFlagsBits.ViewChannel)) {
                issues.warning.push(`**#${channel.name} looks ticket-related but @everyone can view it.** Ticket channels/categories should normally be hidden by default.`);
            }
        }
    }

    const rolePermGroups = new Map();
    for (const role of guild.roles.cache.values()) {
        if (role.managed || role.id === guild.id || role.permissions.bitfield === 0n) continue;
        const key = role.permissions.bitfield.toString();
        if (!rolePermGroups.has(key)) rolePermGroups.set(key, []);
        rolePermGroups.get(key).push(role.name);
    }
    for (const names of rolePermGroups.values()) {
        if (names.length > 1) {
            issues.warning.push(`**Duplicate permission sets:** ${names.join(', ')} all grant identical permissions — consider consolidating.`);
        }
    }

    const unusedRoles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.members.size === 0);
    if (unusedRoles.size > 0) {
        const names = unusedRoles.map((r) => r.name).slice(0, 8);
        issues.info.push(`**${unusedRoles.size} unused role(s)** with no members: ${names.join(', ')}${unusedRoles.size > 8 ? ', ...' : ''}`);
    }

    const inactiveCutoff = Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000;
    const inactiveChannels = textChannels.filter((c) => {
        if (!c.lastMessageId) return true;
        return snowflakeToDate(c.lastMessageId).getTime() < inactiveCutoff;
    });
    if (inactiveChannels.size > 0) {
        issues.info.push(`**${inactiveChannels.size} channel(s) inactive for ${INACTIVE_DAYS}+ days** — consider archiving or removing clutter.`);
    }

    const moderationFlags = PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageGuild;
    const riskyHierarchyRoles = guild.roles.cache.filter((r) =>
        !r.managed && r.id !== guild.id && r.members.size > 0 && (r.permissions.bitfield & moderationFlags) !== 0n && r.position > botMember.roles.highest.position,
    );
    for (const role of riskyHierarchyRoles.values()) {
        issues.warning.push(`**${role.name} sits above my highest role but has moderation permissions.** I can't moderate members with this role. Move my role above it.`);
    }

    if (!guild.rulesChannelId && guild.verificationLevel === 0) {
        issues.info.push(`**No rules channel and verification level is off.** Consider raising server verification level or setting up a rules/verification channel.`);
    }

    const score = Math.max(0, 100 - issues.critical.length * 15 - issues.warning.length * 5 - issues.info.length * 1);

    return { score, issues };
}
