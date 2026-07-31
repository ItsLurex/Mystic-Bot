import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { setRule, removeRule, getCachedRule, listRules } from '../../services/trapBanService.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_BAN_DURATION_DAYS = 365;

export default {
    data: new SlashCommandBuilder()
        .setName('autoban')
        .setDescription('Instantly ban anyone who posts in a trap channel (e.g. a hacked-account honeypot)')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Turn a channel into an auto-ban trap')
                .addChannelOption((option) =>
                    option
                        .setName('rule')
                        .setDescription('The trap channel — anyone who posts here gets banned instantly')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(true))
                .addIntegerOption((option) =>
                    option
                        .setName('banduration')
                        .setDescription('Days until auto-unban (0 = permanent)')
                        .setMinValue(0)
                        .setMaxValue(MAX_BAN_DURATION_DAYS)
                        .setRequired(true))
                .addStringOption((option) =>
                    option
                        .setName('dm_message')
                        .setDescription('Message DM\'d to them before the ban (default message used if left blank)')))
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Turn off the auto-ban trap for a channel')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to stop trapping')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('list')
                .setDescription('List every trap channel configured in this server')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') return handleAdd(interaction);
        if (sub === 'remove') return handleRemove(interaction);
        if (sub === 'list') return handleList(interaction);
    },
};

async function handleAdd(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('rule');
    const banDurationDays = interaction.options.getInteger('banduration');
    const dmMessage = interaction.options.getString('dm_message') || null;

    await setRule(interaction.guild.id, channel.id, banDurationDays, dmMessage);

    const durationLabel = banDurationDays === 0
        ? 'permanently'
        : `for ${banDurationDays} day${banDurationDays === 1 ? '' : 's'}`;

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            `⚠️ ${channel} is now an auto-ban trap.\n\n` +
            `Anyone who sends a message there (except Staff/ignored roles) will be banned ${durationLabel}, ` +
            `their last day of messages deleted, and DM'd ${dmMessage ? 'your custom message' : 'a default notice'} first.`,
        )],
    });
}

async function handleRemove(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');

    if (!getCachedRule(channel.id)) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${channel} is not currently an auto-ban trap.`,
        });
        return;
    }

    await removeRule(channel.id);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`${channel} is no longer an auto-ban trap.`)],
    });
}

async function handleList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const rules = await listRules(interaction.guild.id);

    if (rules.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No auto-ban trap channels are configured in this server.')],
        });
        return;
    }

    const lines = rules.map((rule) => {
        const durationLabel = rule.banDurationDays === 0 ? 'permanent' : `${rule.banDurationDays}d`;
        return `<#${rule.channelId}> — ${durationLabel}`;
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(`**Auto-Ban Traps (${rules.length})**\n\n${lines.join('\n')}`)],
    });
}
