import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user from the server")
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("The user to ban")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option.setName("reason").setDescription("Reason for the ban"),
        )
        .addIntegerOption((option) =>
            option
                .setName("delete_days")
                .setDescription("Days of their messages to delete (0-7, Discord's max)")
                .setMinValue(0)
                .setMaxValue(7),
        )
        .addStringOption((option) =>
            option
                .setName("dm_message")
                .setDescription("Custom message to DM the user before banning (default message used if left blank)"),
        )
        .addBooleanOption((option) =>
            option
                .setName("notify")
                .setDescription("Whether to DM the user at all (default: yes)"),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const user = interaction.options.getUser("target");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const deleteDays = interaction.options.getInteger("delete_days") ?? 0;
        const dmMessage = interaction.options.getString("dm_message");
        const notify = interaction.options.getBoolean("notify") ?? true;

        if (!user) {
            throw new TitanBotError(
                'Missing target user',
                ErrorTypes.USER_INPUT,
                'You must specify a user to ban.',
                { subtype: 'invalid_user' },
            );
        }

        if (user.id === interaction.user.id) {
            throw new TitanBotError(
                'Cannot ban self',
                ErrorTypes.VALIDATION,
                'You cannot ban yourself.',
            );
        }
        if (user.id === client.user.id) {
            throw new TitanBotError(
                'Cannot ban bot',
                ErrorTypes.VALIDATION,
                'You cannot ban the bot.',
            );
        }

        const result = await ModerationService.banUser({
            guild: interaction.guild,
            user,
            moderator: interaction.member,
            reason,
            deleteDays,
            notify,
            dmMessage,
        });

            ? '\n**DM:** Skipped (notify:false)'
            : result.dmSent
                ? '\n**DM:** Sent'
                : '\n**DM:** Could not be delivered (DMs closed or bot blocked)';

        await InteractionHelper.universalReply(interaction, {
            embeds: [
                successEmbed(
                    `🚫 **Banned** ${user.tag}`,
                    `**Reason:** ${reason}\n**Case ID:** #${result.caseId}\n**Messages deleted:** last ${result.deleteDays} day${result.deleteDays === 1 ? '' : 's'}${dmNote}`,
                ),
            ],
        });
    },
};
