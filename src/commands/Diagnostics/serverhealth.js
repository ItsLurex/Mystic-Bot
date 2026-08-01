import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { scanServerHealth } from '../../services/serverHealthService.js';

function scoreColor(score) {
    if (score >= 80) return 0x57F287;
    if (score >= 50) return 0xFEE75C;
    return 0xED4245;
}

function formatList(items, max) {
    if (items.length === 0) return 'None found ✅';
    const shown = items.slice(0, max);
    const extra = items.length - shown.length;
    return `${shown.map((i) => `• ${i}`).join('\n')}${extra > 0 ? `\n*+${extra} more*` : ''}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('serverhealth')
        .setDescription('Scan the server for security, permission, and configuration issues')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    category: 'diagnostics',

    async execute(interaction) {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const { score, issues } = await scanServerHealth(interaction.guild);
        const total = issues.critical.length + issues.warning.length + issues.info.length;

        const embed = new EmbedBuilder()
            .setColor(scoreColor(score))
            .setTitle(`🩺 Server Health: ${score}/100`)
            .setDescription(total === 0
                ? '✅ No issues found — this server looks well configured.'
                : `Found **${total}** issue(s): ${issues.critical.length} critical, ${issues.warning.length} warning, ${issues.info.length} info.`)
            .addFields(
                { name: `🔴 Critical (${issues.critical.length})`, value: formatList(issues.critical, 6) },
                { name: `🟡 Warning (${issues.warning.length})`, value: formatList(issues.warning, 6) },
                { name: `🔵 Info (${issues.info.length})`, value: formatList(issues.info, 4) },
            )
            .setFooter({ text: `Scanned ${interaction.guild.name}` })
            .setTimestamp();

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
