/**
 * Web dashboard configuration
 */

export const webConfig = {
    // Session
    session: {
        secret: process.env.WEB_SESSION_SECRET || process.env.SESSION_SECRET || 'mystic-bot-web-secret-change-me',
        name: 'mystic.sid',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        secure: process.env.NODE_ENV === 'production',
    },

    // Discord OAuth2
    discord: {
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET || '',
        redirectUri: process.env.OAUTH_REDIRECT_URI || process.env.DISCORD_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`,
        scopes: ['identify', 'guilds'],
        authorizeUrl: 'https://discord.com/api/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        apiBase: 'https://discord.com/api/v10',
    },

    // Dashboard
    dashboard: {
        // If true, only bot owners + server admins can access. If false, any MANAGE_GUILD user.
        // For private first, we allow admins of any guild bot is in, but you can restrict to specific guilds via env.
        ownerOnly: process.env.DASHBOARD_OWNER_ONLY === 'true' ? true : false,
        allowedGuildIds: (process.env.DASHBOARD_ALLOWED_GUILDS?.split(',').map(s => s.trim()).filter(Boolean)) || [], // empty = all guilds bot is in
    },

    // Permissions
    permissions: {
        // Discord permission bit for admin. 0x8 = ADMINISTRATOR, 0x20 = MANAGE_GUILD
        adminBits: [0x8, 0x20],
    }
};

export default webConfig;
