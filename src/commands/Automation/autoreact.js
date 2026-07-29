import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
    parseEmojiInput,
    addEmoji,
    removeEmoji,
    clearChannel,
    listRules,
} from '../../services/autoreactService.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function formatEmojiForDisplay(value) {
    // A pure-digit value is a custom emoji id (unicode emoji never look like this),
    // which we can't render without knowing its name, so show it as a raw mention.
    return /^\d+$/.test(value) ? `<:emoji:${value}>` : value;
}

export default {
    data: new SlashCommandBuilder()
        .setName('reactions')
        .setDescription('Configure automatic reactions on every message sent in a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Add an auto-react emoji to a channel')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to react in')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(true))
                .addStringOption((option) =>
                    option
                        .setName('emoji')
                        .setDescription('Pick an emoji from the picker, or paste a custom server emoji')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Remove one auto-react emoji from a channel')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to remove it from')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(true))
                .addStringOption((option) =>
                    option
                        .setName('emoji')
                        .setDescription('The exact emoji to remove')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('clear')
                .setDescription('Remove every auto-react emoji from a channel')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to clear')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('list')
                .setDescription('List every channel with auto-react configured')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') return handleAdd(interaction);
        if (sub === 'remove') return handleRemove(interaction);
        if (sub === 'clear') return handleClear(interaction);
        if (sub === 'list') return handleList(interaction);
    },
};

async function handleAdd(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const parsed = parseEmojiInput(interaction.options.getString('emoji'));

    if (!parsed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'That doesn\'t look like a valid emoji. Use the emoji picker (🙂 icon in the text box) to insert one, or paste a custom server emoji.',
        });
        return;
    }

    try {
        await addEmoji(interaction.guild.id, channel.id, parsed);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Added ${formatEmojiForDisplay(parsed)} as an auto-react in ${channel}.`)],
        });
    } catch (error) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: error.message });
    }
}

async function handleRemove(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const parsed = parseEmojiInput(interaction.options.getString('emoji'));

    if (!parsed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'That doesn\'t look like a valid emoji.',
        });
        return;
    }

    const removed = await removeEmoji(interaction.guild.id, channel.id, parsed);
    if (!removed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `That emoji isn't configured for auto-react in ${channel}.`,
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Removed ${formatEmojiForDisplay(parsed)} from ${channel}'s auto-react list.`)],
    });
}

async function handleClear(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const removed = await clearChannel(channel.id);

    if (!removed) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `${channel} doesn't have any auto-react emojis configured.`,
        });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Cleared all auto-react emojis from ${channel}.`)],
    });
}

async function handleList(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const rules = await listRules(interaction.guild.id);

    if (rules.length === 0) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('No channels have auto-react configured yet.')],
        });
        return;
    }

    const lines = rules.map((rule) => `<#${rule.channelId}> — ${rule.emojis.map(formatEmojiForDisplay).join(' ')}`);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(`**Auto-React Channels (${rules.length})**\n\n${lines.join('\n')}`)],
    });
}
