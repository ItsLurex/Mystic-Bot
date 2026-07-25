import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import { handleSet } from './modules/sticky_set.js';
import { handleEdit } from './modules/sticky_edit.js';
import { handleRemove } from './modules/sticky_remove.js';
import { handleList } from './modules/sticky_list.js';
import { handlePause } from './modules/sticky_pause.js';
import { handleResume } from './modules/sticky_resume.js';

const STICKY_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function addEmbedOptions(subcommand, { required = false } = {}) {
    return subcommand
        .addStringOption((option) =>
            option
                .setName('content')
                .setDescription('Plain text content for the sticky message')
                .setRequired(false)
                .setMaxLength(2000))
        .addStringOption((option) =>
            option
                .setName('title')
                .setDescription('Embed title')
                .setRequired(false)
                .setMaxLength(256))
        .addStringOption((option) =>
            option
                .setName('description')
                .setDescription('Embed description')
                .setRequired(false)
                .setMaxLength(4000))
        .addStringOption((option) =>
            option
                .setName('color')
                .setDescription('Embed color as a hex code, e.g. #5865F2')
                .setRequired(false))
        .addStringOption((option) =>
            option
                .setName('thumbnail')
                .setDescription('Embed thumbnail image URL')
                .setRequired(false))
        .addStringOption((option) =>
            option
                .setName('image')
                .setDescription('Embed image URL')
                .setRequired(false))
        .addStringOption((option) =>
            option
                .setName('footer')
                .setDescription('Embed footer text')
                .setRequired(false)
                .setMaxLength(2048))
        .addStringOption((option) =>
            option
                .setName('author')
                .setDescription('Embed author name')
                .setRequired(false)
                .setMaxLength(256))
        .addBooleanOption((option) =>
            option
                .setName('timestamp')
                .setDescription('Show the current time on the embed')
                .setRequired(false))
        .addIntegerOption((option) =>
            option
                .setName('threshold')
                .setDescription('Repost after this many user messages (1 = every message)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(500));
}

export default {
    data: new SlashCommandBuilder()
        .setName('sticky')
        .setDescription('Manage sticky messages that repost after channel activity')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((subcommand) =>
            addEmbedOptions(
                subcommand
                    .setName('set')
                    .setDescription('Create a sticky message for a channel')
                    .addChannelOption((option) =>
                        option
                            .setName('channel')
                            .setDescription('The channel to post the sticky message in')
                            .addChannelTypes(...STICKY_CHANNEL_TYPES)
                            .setRequired(true)),
            ))
        .addSubcommand((subcommand) =>
            addEmbedOptions(
                subcommand
                    .setName('edit')
                    .setDescription('Edit an existing sticky message')
                    .addChannelOption((option) =>
                        option
                            .setName('channel')
                            .setDescription('The channel whose sticky message to edit')
                            .addChannelTypes(...STICKY_CHANNEL_TYPES)
                            .setRequired(true))
                    .addBooleanOption((option) =>
                        option
                            .setName('enabled')
                            .setDescription('Enable or disable reposting for this sticky')
                            .setRequired(false)),
            ))
        .addSubcommand((subcommand) =>
            subcommand
                .setName('remove')
                .setDescription('Remove a channel\'s sticky message')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel whose sticky message to remove')
                        .addChannelTypes(...STICKY_CHANNEL_TYPES)
                        .setRequired(true)))
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List every sticky message configured in this server'))
        .addSubcommand((subcommand) =>
            subcommand
                .setName('pause')
                .setDescription('Temporarily stop a sticky message from reposting')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel whose sticky message to pause')
                        .addChannelTypes(...STICKY_CHANNEL_TYPES)
                        .setRequired(true)))
        .addSubcommand((subcommand) =>
            subcommand
                .setName('resume')
                .setDescription('Resume a paused sticky message')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel whose sticky message to resume')
                        .addChannelTypes(...STICKY_CHANNEL_TYPES)
                        .setRequired(true))),

    async execute(interaction, guildConfig, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'set':
                await handleSet(interaction, client);
                break;
            case 'edit':
                await handleEdit(interaction, client);
                break;
            case 'remove':
                await handleRemove(interaction, client);
                break;
            case 'list':
                await handleList(interaction, client);
                break;
            case 'pause':
                await handlePause(interaction, client);
                break;
            case 'resume':
                await handleResume(interaction, client);
                break;
            default:
                await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown subcommand.' });
        }
    },
};
