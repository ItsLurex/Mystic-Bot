/**
 * Web Auth Service - Discord OAuth2 + session handling
 */

import axios from 'axios';
import crypto from 'crypto';
import { webConfig } from '../../config/web.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';
import { saveWebSession, getWebSession, deleteWebSession } from '../../utils/database/webSessions.js';

const DISCORD_API_BASE = webConfig.discord.apiBase;

export function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

export function getOAuthAuthorizeUrl(state) {
    const params = new URLSearchParams({
        client_id: webConfig.discord.clientId,
        redirect_uri: webConfig.discord.redirectUri,
        response_type: 'code',
        scope: webConfig.discord.scopes.join(' '),
        state: state,
        prompt: 'consent',
    });
    return `${webConfig.discord.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
    try {
        const params = new URLSearchParams({
            client_id: webConfig.discord.clientId,
            client_secret: webConfig.discord.clientSecret,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: webConfig.discord.redirectUri,
        });

        const response = await axios.post(webConfig.discord.tokenUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        return response.data; // { access_token, token_type, expires_in, refresh_token, scope }
    } catch (error) {
        logger.error('OAuth token exchange failed:', error.response?.data || error.message);
        throw new Error('Failed to exchange code for token');
    }
}

export async function getDiscordUser(accessToken) {
    try {
        const res = await axios.get(`${DISCORD_API_BASE}/users/@me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return res.data;
    } catch (error) {
        logger.error('Failed to get Discord user:', error.response?.data || error.message);
        throw new Error('Failed to fetch Discord user');
    }
}

export async function getDiscordGuilds(accessToken) {
    try {
        const res = await axios.get(`${DISCORD_API_BASE}/users/@me/guilds`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return res.data; // array of guilds with permissions
    } catch (error) {
        logger.error('Failed to get Discord guilds:', error.response?.data || error.message);
        throw new Error('Failed to fetch Discord guilds');
    }
}

export function hasAdminPermission(permissions) {
    // permissions is string of integer, bitwise
    try {
        const perms = BigInt(permissions);
        // ADMINISTRATOR = 0x8, MANAGE_GUILD = 0x20
        const ADMIN = 0x8n;
        const MANAGE_GUILD = 0x20n;
        return (perms & ADMIN) === ADMIN || (perms & MANAGE_GUILD) === MANAGE_GUILD;
    } catch {
        return false;
    }
}

export function isGuildAllowed(guildId) {
    const allowed = webConfig.dashboard.allowedGuildIds;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(guildId);
}

export function canAccessGuild(user, guild, clientGuilds) {
    // Owner bypass
    if (isBotOwner(user.id)) return true;
    if (webConfig.dashboard.ownerOnly && !isBotOwner(user.id)) return false;

    // Must be admin in Discord guild list
    if (!hasAdminPermission(guild.permissions)) return false;

    // Guild must be allowed if whitelist set
    if (!isGuildAllowed(guild.id)) return false;

    // Bot must be in that guild (for private dashboard)
    if (clientGuilds && !clientGuilds.has(guild.id)) return false;

    return true;
}

export async function createSession(client, user, guilds, accessToken, refreshToken) {
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + webConfig.session.maxAge);
    const data = {
        user: {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar,
            global_name: user.global_name,
        },
        guilds: guilds.map(g => ({
            id: g.id,
            name: g.name,
            icon: g.icon,
            permissions: g.permissions,
            owner: g.owner,
        })),
        accessToken,
        refreshToken,
        createdAt: new Date().toISOString(),
    };

    await saveWebSession(client, sessionId, user.id, data, expiresAt);
    return { sessionId, expiresAt, data };
}

export async function getSession(client, sessionId) {
    if (!sessionId) return null;
    const session = await getWebSession(client, sessionId);
    if (!session) return null;
    // session.data contains user + guilds
    return session;
}

export async function destroySession(client, sessionId) {
    if (!sessionId) return;
    await deleteWebSession(client, sessionId);
}

export function getUserAvatarUrl(user) {
    if (!user) return null;
    if (user.avatar) {
        const ext = user.avatar.startsWith('_a') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
    }
    // default avatar based on discriminator
    const disc = parseInt(user.discriminator || '0') % 5;
    return `https://cdn.discordapp.com/embed/avatars/${disc}.png`;
}

export function getGuildIconUrl(guild) {
    if (!guild?.icon) return null;
    const ext = guild.icon.startsWith('_a') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=128`;
}
