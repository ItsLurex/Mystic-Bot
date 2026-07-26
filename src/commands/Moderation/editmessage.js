import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from "discord.js";

import { getEditableMessage } from "../../utils/database/editableMessages.js";

export default {
    data: new SlashCommandBuilder()
        .setName("editmessage")
        .setDescription("Edit a protected bot message")

        .addStringOption(option =>
            option
                .setName("message_id")
                .setDescription("The ID of the message")
                .setRequired(true)
        )

        .setDefaultMemberPermissions(
            PermissionFlagsBits.SendMessages
        ),

    category: "moderation",

    async execute(interaction) {

        const messageId = interaction.options.getString("message_id");

        const editable = await getEditableMessage(messageId);

        if (!editable) {
            return interaction.reply({
                content: "That message is not editable.",
                ephemeral: true,
            });
        }

        const hasRole = interaction.member.roles.cache.some(role =>
            editable.allowed_roles.includes(role.id)
        );

        if (!hasRole) {
            return interaction.reply({
                content: "You are not allowed to edit this message.",
                ephemeral: true,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`editmessage_modal:${messageId}`)
            .setTitle("Edit Message");

        const input = new TextInputBuilder()
            .setCustomId("content")
            .setLabel("New message")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000);

        modal.addComponents(
            new ActionRowBuilder().addComponents(input)
        );

        await interaction.showModal(modal);
    },
};
