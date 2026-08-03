import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { resolveRoleFromInput } from '../../utils/discordInputParsing.js';
import { parseEmojiInput } from '../../services/autoreactService.js';
import { createPanel, addRoleMapping, removeRoleMapping, deletePanel, getCachedPanel } from '../../services/reactionRolePanelService.js';

const LINK_PATTERN = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/;
function parseLink(link) {
    const m = LINK_PATTERN.exec((link || '').trim());
    return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

export default {
    data: new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Set up a message where reacting with an emoji gives a role')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .setDMPermission(false)
        .addSubcommand((s) => s.setName('create').setDescription('Post a new reaction-role message')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addStringOption((o) => o.setName('title').setDescription('Embed title').setRequired(true))
            .addStringOption((o) => o.setName('description').setDescription('Explain what each reaction/emoji means here').setRequired(true)))
        .addSubcommand((s) => s.setName('addrole').setDescription('Add a role+emoji pair to a reaction-role message')
            .addStringOption((o) => o.setName('message_link').setDescription('Right-click the message → Copy Message Link').setRequired(true))
            .addStringOption((o) => o.setName('role').setDescription('Type or paste the role mention, e.g. @Member').setRequired(true))
            .addStringOption((o) => o.setName('emoji').setDescription('Pick from the emoji picker, or paste a custom server emoji').setRequired(true)))
        .addSubcommand((s) => s.setName('removerole').setDescription('Remove a role+emoji pair')
            .addStringOption((o) => o.setName('message_link').setDescription('Right-click the message → Copy Message Link').setRequired(true))
            .addStringOption((o) => o.setName('emoji').setDescription('The exact emoji to remove').setRequired(true)))
        .addSubcommand((s) => s.setName('delete').setDescription('Stop tracking a reaction-role message (does not delete the Discord message)')
            .addStringOption((o) => o.setName('message_link').setDescription('Right-click the message → Copy Message Link').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'create') return handleCreate(interaction);
        if (sub === 'addrole') return handleAddRole(interaction);
        if (sub === 'removerole') return handleRemoveRole(interaction);
        if (sub === 'delete') return handleDelete(interaction);
    },
};

async function handleCreate(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `I need View/Send/Embed permissions in ${channel}.` });
        return;
    }

    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865F2);
    const message = await channel.send({ embeds: [embed] });
    await createPanel(interaction.guild.id, channel.id, message.id);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(`Reaction-role message posted in ${channel}.\n\nNow use \`/reactionrole addrole\` with this link to add roles:\n${message.url}`)],
    });
}

async function handleAddRole(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const parsed = parseLink(interaction.options.getString('message_link'));
    if (!parsed || parsed.guildId !== interaction.guild.id) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That doesn\'t look like a valid message link from this server.' });
        return;
    }

    const panel = getCachedPanel(parsed.messageId);
    if (!panel) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That message isn\'t a reaction-role panel. Create one first with `/reactionrole create`.' });
        return;
    }

    const role = resolveRoleFromInput(interaction.guild, interaction.options.getString('role'));
    if (!role) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Could not find that role. Type or paste a real role mention, e.g. `@Member`.' });
        return;
    }

    const emojiKey = parseEmojiInput(interaction.options.getString('emoji'));
    if (!emojiKey) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That doesn\'t look like a valid emoji.' });
        return;
    }

    const botMember = interaction.guild.members.me;
    if (botMember.roles.highest.position <= role.position) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I can't assign ${role} — it's above my highest role.` });
        return;
    }

    try {
        const channel = await interaction.client.channels.fetch(parsed.channelId);
        const message = await channel.messages.fetch(parsed.messageId);
        await message.react(emojiKey);
        await addRoleMapping(parsed.messageId, emojiKey, role.id);
        await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(`Reacting with that emoji now gives ${role}.`)] });
    } catch (error) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Could not react to that message — check the link and my permissions.' });
    }
}

async function handleRemoveRole(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const parsed = parseLink(interaction.options.getString('message_link'));
    if (!parsed || !getCachedPanel(parsed.messageId)) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That message isn\'t a tracked reaction-role panel.' });
        return;
    }

    const emojiKey = parseEmojiInput(interaction.options.getString('emoji'));
    if (!emojiKey) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That doesn\'t look like a valid emoji.' });
        return;
    }

    await removeRoleMapping(parsed.messageId, emojiKey);

    try {
        const channel = await interaction.client.channels.fetch(parsed.channelId);
        const message = await channel.messages.fetch(parsed.messageId);
        const reaction = message.reactions.cache.find((r) => (r.emoji.id || r.emoji.name) === emojiKey);
        await reaction?.remove().catch(() => {});
    } catch {
        // Message/reaction cleanup is best-effort; the role mapping is already removed either way.
    }

    await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Role mapping removed.')] });
}

async function handleDelete(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const parsed = parseLink(interaction.options.getString('message_link'));
    if (!parsed || !(await deletePanel(parsed?.messageId))) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That message isn\'t a tracked reaction-role panel.' });
        return;
    }

    await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Stopped tracking that reaction-role message (the message itself was left alone).')] });
}
