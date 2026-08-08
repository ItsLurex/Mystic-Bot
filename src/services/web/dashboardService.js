/**
 * Dashboard Service - provides data for web dashboard
 */

import { getGuildConfig } from '../config/guildConfig.js';
import { getGuildLogs, getGuildLogStats } from '../../utils/database/guildLogs.js';
import { logger } from '../../utils/logger.js';
import { getLoggingStatus } from '../loggingService.js';

export async function getGuildDashboardData(client, guildId) {
    try {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return null;

        const config = await getGuildConfig(client, guildId);
        const loggingStatus = await getLoggingStatus(client, guildId);
        const logStats = await getGuildLogStats(client, guildId);

        // Fetch recent logs (50)
        const recentLogs = await getGuildLogs(client, guildId, { limit: 50 });

        // Counters
        const members = guild.memberCount || 0;
        const channels = guild.channels.cache.size;
        const roles = guild.roles.cache.size;

        return {
            guild: {
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL?.({ size: 128 }) || null,
                memberCount: members,
                channelCount: channels,
                roleCount: roles,
                createdAt: guild.createdTimestamp,
            },
            config: {
                prefix: config?.prefix,
                disabledCommands: Object.keys(config?.disabledCommands || {}).length,
                disabledCategories: Object.keys(config?.disabledCategories || {}).length,
                logging: loggingStatus,
            },
            logStats,
            recentLogs,
        };
    } catch (error) {
        logger.error(`Error getting dashboard data for guild ${guildId}:`, error);
        return null;
    }
}

export async function getGuildLogsData(client, guildId, options = {}) {
    try {
        const logs = await getGuildLogs(client, guildId, options);
        const stats = await getGuildLogStats(client, guildId);
        return { logs, stats };
    } catch (error) {
        logger.error(`Error getting logs for guild ${guildId}:`, error);
        return { logs: [], stats: { total: 0, byType: {} } };
    }
}

export async function getAllGuildsForAdmin(client, adminGuilds) {
    // adminGuilds is array from Discord OAuth (with permissions)
    // Filter to only guilds where bot is present and user has admin
    const result = [];
    for (const g of adminGuilds) {
        const botGuild = client.guilds.cache.get(g.id);
        if (botGuild) {
            result.push({
                id: g.id,
                name: botGuild.name,
                icon: botGuild.iconURL?.({ size: 128 }) || (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null),
                memberCount: botGuild.memberCount,
                botPresent: true,
            });
        }
    }
    return result;
}
