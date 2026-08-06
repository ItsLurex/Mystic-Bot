import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { resolveRoleFromInput } from '../../utils/discordInputParsing.js';
import { scanServerHealth } from '../../services/serverHealthService.js';
import { getApprovedRoles, addApprovedRole, removeApprovedRole } from '../../utils/database/approvedAdminRoles.js';

function scoreColor(score) {
    if (score >= 80) return 0x57F287;
    if (score >= 50) return 0xFEE75C;
    return 0xED4245;
}

function formatList(items, max) {
    if (items.length === 0) return 'None found ✅';
    const shown = items.slice(0, max);
    const extra = items.length - shown.length;
    return `${shown.map((i) => `• ${i}`).join('\n')}${extra > 0 ? `\n*+${extra} more*` : ''}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('serverhealth')
        .setDescription('Scan the server for security, permission, and configuration issues')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((sub) => sub.setName('scan').setDescription('Run the health scan'))
        .addSubcommand((sub) =>
            sub
                .setName('approve')
                .setDescription('Approve a role having Administrator so the scanner stops flagging it')
                .addStringOption((option) =>
                    option.setName('role').setDescription('Type or paste the role mention, e.g. @Staff').setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('unapprove')
                .setDescription('Remove a role from the approved-admin list')
                .addStringOption((option) =>
                    option.setName('role').setDescription('Type or paste the role mention, e.g. @Staff').setRequired(true)))
        .addSubcommand((sub) => sub.setName('approved').setDescription('List every approved admin role')),
    category: 'diagnostics',

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'scan') return handleScan(interaction);
        if (sub === 'approve') return handleApprove(interaction);
        if (sub === 'unapprove') return handleUnapprove(interaction);
        if (sub === 'approved') return handleApprovedList(interaction);
    },
};

async function handleScan(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const approvedRoleIds = await getApprovedRoles(interaction.guild.id);
    const { score, issues } = await scanServerHealth(interaction.guild, approvedRoleIds);
    const total = issues.critical.length + issues.warning.length + issues.info.length;

    const embed = new EmbedBuilder()
        .setColor(scoreColor(score))
        .setTitle(`🩺 Server Health: ${score}/100`)
        .setDescription(total === 0
            ? '✅ No issues found — this server looks well configured.'
            : `Found **${total}** issue(s): ${issues.critical.length} critical, ${issues.warning.length} warning, ${issues.info.length} info.`)
        .addFields(
            { name: `🔴 Critical (${issues.critical.length})`, value: formatList(issues.critical, 6) },
            { name: `🟡 Warning (${issues.warning.length})`, value: formatList(issues.warning, 6) },
            { name: `🔵 Info (${issues.info.length})`, value: formatList(issues.info, 4) },
        )
        .setFooter({ text: `Scanned ${interaction.guild.name} • /serverhealth approve to whitelist an admin role` })
        .setTimestamp();

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleApprove(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const role = resolveRoleFromInput(interaction.guild, interaction.options.getString('role'));
    if (!role) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Could not find that role. Type or paste a real role mention, e.g. `@Staff`.',
        });
        return;
    }

    await addApprovedRole(interaction.guild.id, role.id);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${role} is now approved to have Administrator — future scans will skip flagging it.`)],
    });
}

async function handleUnapprove(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const role = resolveRoleFromInput(interaction.guild, interaction.options.getString('role'));
    if (!role) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Could not find that role. Type or paste a real role mention, e.g. `@Staff`.',
        });
        return;
    }

    const removed = await removeApprovedRole(interaction.guild.id, role.id);
    if (!removed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${role} isn't on the approved list.`,
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${role} removed from the approved list — future scans will flag it again if it still has Administrator.`)],
    });
}

async function handleApprovedList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const roleIds = await getApprovedRoles(interaction.guild.id);
    if (roleIds.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No roles are currently approved for Administrator.')],
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(`**Approved Admin Roles (${roleIds.length})**\n\n${roleIds.map((id) => `<@&${id}>`).join(', ')}`)],
    });
}
