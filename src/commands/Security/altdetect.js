import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import {
    ALT_DETECT_ACTIONS,
    getConfig,
    saveConfig,
    scanGuild,
    listFlags,
    clearFlag,
    removeFlag,
} from '../../services/altDetectService.js';

const MAX_THRESHOLD_DAYS = 365;
const MAX_LIST_LINES = 50;

const ACTION_LABELS = {
    alert: 'Alert only (flag + notify staff)',
    kick: 'Kick on join',
    ban: 'Ban on join',
};

export default {
    data: new SlashCommandBuilder()
        .setName('altdetect')
        .setDescription('Detect suspected alt accounts (young accounts) joining or living in this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub.setName('status').setDescription('Show the current Alt Detector configuration'))
        .addSubcommand((sub) =>
            sub.setName('enable').setDescription('Turn the Alt Detector on for new members'))
        .addSubcommand((sub) =>
            sub.setName('disable').setDescription('Turn the Alt Detector off'))
        .addSubcommand((sub) =>
            sub
                .setName('threshold')
                .setDescription('Set the minimum account age (in days) for new members')
                .addIntegerOption((option) =>
                    option
                        .setName('days')
                        .setDescription('Accounts younger than this many days get flagged/actioned')
                        .setMinValue(0)
                        .setMaxValue(MAX_THRESHOLD_DAYS)
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('action')
                .setDescription('What happens to new accounts under the threshold')
                .addStringOption((option) =>
                    option
                        .setName('mode')
                        .setDescription('Alert only, kick, or ban')
                        .addChoices(
                            { name: 'Alert only (recommended)', value: 'alert' },
                            { name: 'Kick on join', value: 'kick' },
                            { name: 'Ban on join', value: 'ban' },
                        )
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('channel')
                .setDescription('Set the channel for Alt Detector alerts (run with no channel to clear)')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('Text channel that receives alt-account alerts')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand((sub) =>
            sub
                .setName('dm')
                .setDescription('Whether to DM members before kicking/banning them')
                .addBooleanOption((option) =>
                    option
                        .setName('enabled')
                        .setDescription('Send a DM explaining the action before it happens')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('exempt')
                .setDescription('Exempt a role from the Alt Detector (e.g. verified members)')
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('Members with this role are never flagged or actioned')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('unexempt')
                .setDescription('Remove a role from the Alt Detector exemption list')
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('The role to stop exempting')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub.setName('scan').setDescription('Scan current members and flag accounts under the threshold (report only)'))
        .addSubcommand((sub) =>
            sub.setName('list').setDescription('List every user currently flagged as a suspected alt'))
        .addSubcommand((sub) =>
            sub
                .setName('clear')
                .setDescription('Mark a flagged user as reviewed/approved (keeps the history)')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('The flagged user to approve')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('unflag')
                .setDescription('Delete a flag record entirely')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('The user whose flag record should be removed')
                        .setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'status') return handleStatus(interaction);
        if (sub === 'enable') return handleSetEnabled(interaction, true);
        if (sub === 'disable') return handleSetEnabled(interaction, false);
        if (sub === 'threshold') return handleThreshold(interaction);
        if (sub === 'action') return handleAction(interaction);
        if (sub === 'channel') return handleChannel(interaction);
        if (sub === 'dm') return handleDm(interaction);
        if (sub === 'exempt') return handleExempt(interaction, true);
        if (sub === 'unexempt') return handleExempt(interaction, false);
        if (sub === 'scan') return handleScan(interaction);
        if (sub === 'list') return handleList(interaction);
        if (sub === 'clear') return handleClear(interaction);
        if (sub === 'unflag') return handleUnflag(interaction);
    },
};

async function handleStatus(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const config = await getConfig(interaction.guild.id);
    const flags = await listFlags(interaction.guild.id);
    const openFlags = flags.filter((flag) => !['banned', 'cleared'].includes(flag.status));

    const embed = new EmbedBuilder()
        .setTitle('🕵️ Alt Detector — configuration')
        .setColor(getColor('info'))
        .addFields(
            { name: 'Status', value: config.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
            { name: 'Minimum account age', value: `${config.minAccountAgeDays} day(s)`, inline: true },
            { name: 'Action', value: ACTION_LABELS[config.action] || config.action, inline: true },
            { name: 'Alert channel', value: config.alertChannelId ? `<#${config.alertChannelId}>` : 'Not set', inline: true },
            { name: 'DM before kick/ban', value: config.dmUser ? 'Yes' : 'No', inline: true },
            {
                name: 'Exempt roles',
                value: config.exemptRoleIds.length > 0
                    ? config.exemptRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')
                    : 'None',
                inline: true,
            },
            {
                name: 'Flags',
                value: `${openFlags.length} open / ${flags.length} total`,
                inline: true,
            },
        )
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleSetEnabled(interaction, enabled) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const config = await getConfig(interaction.guild.id);

    if (config.enabled === enabled) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed(`Alt Detector is already ${enabled ? 'enabled' : 'disabled'} in this server.`)],
        });
        return;
    }

    await saveConfig({ ...config, enabled });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            enabled
                ? `Alt Detector is now **enabled**. New accounts under **${config.minAccountAgeDays} day(s)** will be handled with: **${ACTION_LABELS[config.action] || config.action}**.` +
                  `${config.alertChannelId ? `\nAlerts go to <#${config.alertChannelId}>.` : '\n⚠️ No alert channel set — use `/altdetect channel` so staff can see alerts.'}`
                : 'Alt Detector is now **disabled**. New members are no longer checked.',
        )],
    });
}

async function handleThreshold(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const days = interaction.options.getInteger('days');
    const config = await getConfig(interaction.guild.id);
    await saveConfig({ ...config, minAccountAgeDays: days });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            `Minimum account age set to **${days} day(s)**.` +
            `\nAccounts younger than this are ${config.enabled ? `currently **${ACTION_LABELS[config.action] || config.action}**` : 'actioned once the detector is enabled'}.`,
        )],
    });
}

async function handleAction(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const mode = interaction.options.getString('mode');
    if (!ALT_DETECT_ACTIONS.includes(mode)) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Invalid action mode. Choose alert, kick, or ban.',
        });
        return;
    }

    const config = await getConfig(interaction.guild.id);
    await saveConfig({ ...config, action: mode });

    const warning = mode !== 'alert'
        ? '\n⚠️ Automatic kick/ban applies to **new joins only** — run `/altdetect scan` for a report on current members (the scan never removes anyone).'
        : '';

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Action for new accounts under the threshold: **${ACTION_LABELS[mode]}**.${warning}`)],
    });
}

async function handleChannel(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const config = await getConfig(interaction.guild.id);

    if (!channel) {
        if (!config.alertChannelId) {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [infoEmbed('No alert channel is currently set.')],
            });
            return;
        }
        await saveConfig({ ...config, alertChannelId: null });
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Alt Detector alert channel cleared.')],
        });
        return;
    }

    await saveConfig({ ...config, alertChannelId: channel.id });
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Alt Detector alerts will now be sent to ${channel}.`)],
    });
}

async function handleDm(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const enabled = interaction.options.getBoolean('enabled');
    const config = await getConfig(interaction.guild.id);
    await saveConfig({ ...config, dmUser: enabled });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            enabled
                ? 'Members will be DM\'d an explanation before any automatic kick or ban.'
                : 'Members will no longer be DM\'d before automatic kicks or bans.',
        )],
    });
}

async function handleExempt(interaction, adding) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const role = interaction.options.getRole('role');
    const config = await getConfig(interaction.guild.id);
    const exempt = new Set(config.exemptRoleIds);

    if (adding && exempt.has(role.id)) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed(`${role} is already exempt from the Alt Detector.`)],
        });
        return;
    }

    if (!adding && !exempt.has(role.id)) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${role} is not on the exemption list.`,
        });
        return;
    }

    if (adding) {
        exempt.add(role.id);
    } else {
        exempt.delete(role.id);
    }

    await saveConfig({ ...config, exemptRoleIds: [...exempt] });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            adding
                ? `${role} is now exempt — members with this role are never flagged or actioned by the Alt Detector.`
                : `${role} is no longer exempt from the Alt Detector.`,
        )],
    });
}

async function handleScan(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const { scanned, flagged, skippedCleared, config } = await scanGuild(interaction.guild);

    if (flagged.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `Scan complete — checked **${scanned}** member(s) against a threshold of **${config.minAccountAgeDays} day(s)**. No suspected alt accounts found.`,
            )],
        });
        return;
    }

    const lines = flagged
        .sort((a, b) => a.ageDays - b.ageDays)
        .slice(0, MAX_LIST_LINES)
        .map(({ member, ageDays }) =>
            `<@${member.user.id}> — account created <t:${Math.floor(member.user.createdAt.getTime() / 1000)}:R> (${Math.floor(ageDays)}d)`);

    const overflow = flagged.length - lines.length;

    const embed = new EmbedBuilder()
        .setTitle(`🕵️ Alt Detector scan — ${flagged.length} suspected alt account(s)`)
        .setDescription(
            `Threshold: **${config.minAccountAgeDays} day(s)** • Scanned: **${scanned}** member(s)` +
            `${skippedCleared > 0 ? ` • Skipped ${skippedCleared} previously cleared account(s)` : ''}\n\n` +
            lines.join('\n') +
            (overflow > 0 ? `\n…and ${overflow} more (use \`/altdetect list\` to see all flags)` : ''),
        )
        .setColor(getColor('warning'))
        .setFooter({ text: 'The scan only flags accounts — it never kicks or bans anyone.' })
        .setTimestamp();

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const flags = await listFlags(interaction.guild.id);

    if (flags.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No users are flagged by the Alt Detector in this server.')],
        });
        return;
    }

    const statusIcon = {
        flagged: '🚩',
        alerted: '🔔',
        kicked: '👢',
        banned: '🔨',
        cleared: '✅',
    };

    const lines = flags.slice(0, MAX_LIST_LINES).map((flag) => {
        const icon = statusIcon[flag.status] || '❔';
        const age = flag.accountAgeDays == null ? 'age ?' : `${flag.accountAgeDays}d old at detection`;
        return `${icon} <@${flag.userId}> — ${flag.status} (${flag.source}, ${age})`;
    });

    const overflow = flags.length - lines.length;

    const embed = new EmbedBuilder()
        .setTitle(`🕵️ Alt Detector flags — ${flags.length} record(s)`)
        .setDescription(
            `${lines.join('\n')}` +
            (overflow > 0 ? `\n…and ${overflow} more.` : ''),
        )
        .setColor(getColor('info'))
        .setFooter({ text: 'Use /altdetect clear to approve a user, or /altdetect unflag to delete a record.' })
        .setTimestamp();

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleClear(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const user = interaction.options.getUser('user');
    const cleared = await clearFlag(interaction.guild.id, user.id);

    if (!cleared) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${user} has no Alt Detector flag in this server.`,
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${user} has been marked as reviewed/approved. They will no longer be flagged by the detector.`)],
    });
}

async function handleUnflag(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const user = interaction.options.getUser('user');
    const removed = await removeFlag(interaction.guild.id, user.id);

    if (!removed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${user} has no Alt Detector flag in this server.`,
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Flag record for ${user} has been deleted.`)],
    });
}
