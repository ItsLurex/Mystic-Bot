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
