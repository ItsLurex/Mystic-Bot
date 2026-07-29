import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { resolveRoleFromInput } from '../../utils/discordInputParsing.js';
import {
    getCachedAutoroleConfig,
    setMemberAutorole,
    setBotAutorole,
    clearMemberAutorole,
    clearBotAutorole,
} from '../../services/autoroleService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('joinrole')
        .setDescription('Configure roles automatically given to new members and bots on join')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('set')
                .setDescription('Set the auto-role for humans or bots')
                .addStringOption((option) =>
                    option
                        .setName('type')
                        .setDescription('Who this role applies to')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Members (humans)', value: 'member' },
                            { name: 'Bots', value: 'bot' },
                        ))
                .addStringOption((option) =>
                    option
                        .setName('role')
                        .setDescription('Type or paste the role mention, e.g. @Member')
                        .setRequired(true)))
        .addSubcommand((sub) =>
            sub
                .setName('clear')
                .setDescription('Stop auto-assigning a role')
                .addStringOption((option) =>
                    option
                        .setName('type')
                        .setDescription('Which auto-role to clear')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Members (humans)', value: 'member' },
                            { name: 'Bots', value: 'bot' },
                        )))
        .addSubcommand((sub) =>
            sub
                .setName('view')
                .setDescription('Show the currently configured auto-roles')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'set') return handleSet(interaction);
        if (sub === 'clear') return handleClear(interaction);
        if (sub === 'view') return handleView(interaction);
    },
};

async function handleSet(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const type = interaction.options.getString('type');
    const role = resolveRoleFromInput(interaction.guild, interaction.options.getString('role'));

    if (!role) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Could not find that role. Type or paste a real role mention, e.g. `@Member`.',
        });
        return;
    }

    const botMember = interaction.guild.members.me;
    if (botMember.roles.highest.position <= role.position) {
        await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `I can't assign ${role} — it's positioned above (or equal to) my own highest role. Move my role above it in Server Settings → Roles.`,
        });
        return;
    }

    if (type === 'member') {
        await setMemberAutorole(interaction.guild.id, role.id);
    } else {
        await setBotAutorole(interaction.guild.id, role.id);
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`New ${type === 'member' ? 'members' : 'bots'} will now automatically receive ${role} on join.`)],
    });
}

async function handleClear(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const type = interaction.options.getString('type');

    if (type === 'member') {
        await clearMemberAutorole(interaction.guild.id);
    } else {
        await clearBotAutorole(interaction.guild.id);
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Auto-role for ${type === 'member' ? 'members' : 'bots'} has been cleared.`)],
    });
}

async function handleView(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const config = getCachedAutoroleConfig(interaction.guild.id);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed(
            `**Auto-Roles**\n\n` +
            `Members: ${config.memberRoleId ? `<@&${config.memberRoleId}>` : 'Not set'}\n` +
            `Bots: ${config.botRoleId ? `<@&${config.botRoleId}>` : 'Not set'}`,
        )],
    });
}
