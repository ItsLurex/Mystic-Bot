import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
    RULE_TYPES,
    getRuleLabel,
    getCachedRule,
    setRule,
    removeRule,
    listRules,
    purgeChannelMessages,
} from '../../services/automodService.js';
import { getIgnoredRoleIds, addIgnoredRole, removeIgnoredRole } from '../../services/ignoredRolesService.js';
import { resolveRoleFromInput } from '../../utils/discordInputParsing.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_PURGE_AMOUNT = 1000;

export default {
    data: new SlashCommandBuilder()
        .setName('automod')
        .setDescription('Configure Auto-Moderation channel rules, ignored roles, and bulk purges')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false)
        .addSubcommandGroup((group) =>
            group
                .setName('rule')
                .setDescription('Manage per-channel Auto-Moderation rules')
                .addSubcommand((sub) =>
                    sub
                        .setName('add')
                        .setDescription('Apply an Auto-Moderation rule to a channel')
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('The channel to apply the rule to')
                                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                                .setRequired(true))
                        .addStringOption((option) =>
                            option
                                .setName('type')
                                .setDescription('The rule to apply')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Auto-delete every message', value: RULE_TYPES.AUTO_DELETE },
                                    { name: 'Vouch format (Vouch @user)', value: RULE_TYPES.VOUCH_FORMAT },
                                )))
                .addSubcommand((sub) =>
                    sub
                        .setName('remove')
                        .setDescription('Remove a channel\'s Auto-Moderation rule')
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('The channel to remove the rule from')
                                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                                .setRequired(true)))
                .addSubcommand((sub) =>
                    sub
                        .setName('list')
                        .setDescription('List every Auto-Moderation rule in this server')))
        .addSubcommandGroup((group) =>
            group
                .setName('ignore')
                .setDescription('Manage roles that bypass Auto-Moderation and invite tracking')
                .addSubcommand((sub) =>
                    sub
                        .setName('add')
                        .setDescription('Add a role to the ignored-roles list')
                        .addStringOption((option) =>
                            option
                                .setName('role')
                                .setDescription('Type or paste the role mention, e.g. @Staff (avoids Discord\'s hierarchy-limited role picker)')
                                .setRequired(true)))
                .addSubcommand((sub) =>
                    sub
                        .setName('remove')
                        .setDescription('Remove a role from the ignored-roles list')
                        .addStringOption((option) =>
                            option
                                .setName('role')
                                .setDescription('Type or paste the role mention, e.g. @Staff')
                                .setRequired(true)))
                .addSubcommand((sub) =>
                    sub
                        .setName('list')
                        .setDescription('List every ignored role in this server')))
        .addSubcommand((sub) =>
            sub
                .setName('purge')
                .setDescription('Bulk-delete recent messages in a channel')
                .addIntegerOption((option) =>
                    option
                        .setName('amount')
                        .setDescription('How many messages to delete (max 1000, cannot be older than 14 days)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(MAX_PURGE_AMOUNT))
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('Channel to purge (defaults to the current channel)')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(false))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        if (group === 'rule' && sub === 'add') return handleRuleAdd(interaction);
        if (group === 'rule' && sub === 'remove') return handleRuleRemove(interaction);
        if (group === 'rule' && sub === 'list') return handleRuleList(interaction);
        if (group === 'ignore' && sub === 'add') return handleIgnoreAdd(interaction);
        if (group === 'ignore' && sub === 'remove') return handleIgnoreRemove(interaction);
        if (group === 'ignore' && sub === 'list') return handleIgnoreList(interaction);
        if (!group && sub === 'purge') return handlePurge(interaction);

        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
    },
};

async function handleRuleAdd(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const ruleType = interaction.options.getString('type');

    try {
        await setRule(interaction.guild.id, channel.id, ruleType);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Applied **${getRuleLabel(ruleType)}** to ${channel}.`)],
        });
    } catch (error) {
        if (error instanceof TitanBotError) {
            await replyUserError(interaction, { type: error.type, message: error.userMessage });
            return;
        }
        logger.error(`[AutoMod] Error adding rule for channel ${channel.id}:`, error);
        throw error;
    }
}

async function handleRuleRemove(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');

    if (!getCachedRule(channel.id)) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${channel} does not have an Auto-Moderation rule.`,
        });
        return;
    }

    await removeRule(channel.id);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Removed the Auto-Moderation rule from ${channel}.`)],
    });
}

async function handleRuleList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const rules = await listRules(interaction.guild.id);

    if (rules.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No Auto-Moderation rules are configured in this server yet.')],
        });
        return;
    }

    const lines = rules.map((rule) => `<#${rule.channelId}> — ${getRuleLabel(rule.ruleType)}`);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(`**Auto-Moderation Rules (${rules.length})**\n\n${lines.join('\n')}`)],
    });
}

async function handleIgnoreAdd(interaction) {
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

    await addIgnoredRole(interaction.guild.id, role.id);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${role} is now ignored by Auto-Moderation and invite tracking.`)],
    });
}

async function handleIgnoreRemove(interaction) {
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

    await removeIgnoredRole(interaction.guild.id, role.id);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${role} is no longer ignored.`)],
    });
}

async function handleIgnoreList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const roleIds = getIgnoredRoleIds(interaction.guild.id);

    if (roleIds.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No roles are currently ignored (Administrators and Manage Messages holders always bypass Auto-Moderation regardless).')],
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(`**Ignored Roles (${roleIds.length})**\n\n${roleIds.map((id) => `<@&${id}>`).join(', ')}`)],
    });
}

async function handlePurge(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    const amount = interaction.options.getInteger('amount');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const botPermissions = channel.permissionsFor(interaction.guild.members.me);
    if (!botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: `I need **Manage Messages** permission in ${channel} to purge messages.`,
        });
        return;
    }

    try {
        const deletedCount = await purgeChannelMessages(channel, amount);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `Deleted **${deletedCount}** message${deletedCount === 1 ? '' : 's'} in ${channel}.` +
                (deletedCount < amount
                    ? '\n\nNote: Discord cannot bulk-delete messages older than 14 days, so fewer than requested may have been removed.'
                    : ''),
            )],
        });
    } catch (error) {
        logger.error(`[AutoMod] Error purging channel ${channel.id}:`, error);
        throw error;
    }
}
