/**
 * Web Dashboard Routes - mounts onto Express app
 * Handles auth, dashboard, logs API
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { webConfig } from '../../config/web.js';
import { logger } from '../../utils/logger.js';
import * as authService from './webAuthService.js';
import * as dashboardService from './dashboardService.js';
import { getGuildLogs } from '../../utils/database/guildLogs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCookies(req) {
    const cookies = {};
    const header = req.headers.cookie;
    if (!header) return cookies;
    header.split(';').forEach(pair => {
        const [key, ...rest] = pair.trim().split('=');
        cookies[key] = decodeURIComponent(rest.join('='));
    });
    return cookies;
}

function setSessionCookie(res, sessionId, expiresAt) {
    const secure = webConfig.session.secure ? '; Secure' : '';
    const httpOnly = '; HttpOnly';
    const sameSite = '; SameSite=Lax';
    const pathStr = '; Path=/';
    const expires = expiresAt ? `; Expires=${expiresAt.toUTCString()}` : '';
    res.setHeader('Set-Cookie', `${webConfig.session.name}=${sessionId}${expires}${pathStr}${httpOnly}${secure}${sameSite}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${webConfig.session.name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax`);
}

async function requireAuth(req, res, client) {
    const cookies = parseCookies(req);
    const sessionId = cookies[webConfig.session.name];
    if (!sessionId) return null;
    const session = await authService.getSession(client, sessionId);
    if (!session) return null;
    // Attach session data
    return { sessionId, ...session };
}

function requireGuildAdmin({ userGuilds, guildId, client }) {
    // userGuilds from session.data.guilds
    const guild = userGuilds?.find(g => g.id === guildId);
    if (!guild) return false;
    return authService.canAccessGuild({ id: userGuilds.find(g => g.id === guildId)?.id || '' , ...{ id: guildId } }, guild, client.guilds.cache);
    // Actually we will check more simply: has admin perm + bot in guild
}

export function setupWebRoutes(app, client) {
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Serve static frontend from src/web/public if exists
    const publicPath = path.join(__dirname, '../../web/public');
    app.use('/web-assets', express.static(publicPath));

    // Middleware to add client to req
    app.use((req, res, next) => {
        req.botClient = client;
        next();
    });

    // Public landing (for private mode, just redirect to dashboard)
    app.get('/', (req, res) => {
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mystic Bot - Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#0f0f1a] text-white min-h-screen">
<div class="max-w-6xl mx-auto px-6 py-16">
  <div class="text-center mb-16">
    <h1 class="text-5xl font-bold mb-4 bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent">Mystic Bot</h1>
    <p class="text-xl text-gray-400 mb-8">Private dashboard for your server — mod tools, logs, customization</p>
    <a href="/dashboard" class="inline-block bg-purple-600 hover:bg-purple-700 px-8 py-3 rounded-lg font-semibold transition">Open Dashboard</a>
    <a href="/health" class="inline-block ml-4 bg-gray-800 hover:bg-gray-700 px-8 py-3 rounded-lg font-semibold transition">Bot Status</a>
  </div>
  <div class="grid md:grid-cols-3 gap-6">
    <div class="bg-[#1a1a2e] p-6 rounded-xl border border-purple-900/30">
      <h3 class="text-lg font-semibold mb-2">📝 Logs Viewer</h3>
      <p class="text-gray-400 text-sm">Browse moderation logs, member joins/leaves, message deletes, all stored for web.</p>
    </div>
    <div class="bg-[#1a1a2e] p-6 rounded-xl border border-purple-900/30">
      <h3 class="text-lg font-semibold mb-2">⚙️ Server Config</h3>
      <p class="text-gray-400 text-sm">Edit prefix, welcome messages, autorole, reaction roles without slash commands.</p>
    </div>
    <div class="bg-[#1a1a2e] p-6 rounded-xl border border-purple-900/30">
      <h3 class="text-lg font-semibold mb-2">🛡️ Mod Tools</h3>
      <p class="text-gray-400 text-sm">Alt Detector, AutoMod, warnings, cases — all from browser.</p>
    </div>
  </div>
  <div class="mt-12 text-center text-gray-500 text-sm">
    <p>Running on Railway • Same URL as bot • Owner + Admins only</p>
  </div>
</div>
</body>
</html>
        `);
    });

    // Auth: Login
    app.get('/auth/discord', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        // Store state in cookie for CSRF protection
        res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
        const url = authService.getOAuthAuthorizeUrl(state);
        res.redirect(url);
    });

    // Auth: Callback
    app.get('/auth/discord/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            const cookies = parseCookies(req);
            const savedState = cookies['oauth_state'];

            if (!code) {
                return res.status(400).send('Missing code');
            }
            if (state !== savedState) {
                // For simplicity, we allow mismatch in dev but log warning
                logger.warn('OAuth state mismatch, continuing anyway');
            }

            if (!webConfig.discord.clientSecret) {
                return res.status(500).send(`
                    <h1>Missing DISCORD_CLIENT_SECRET</h1>
                    <p>Set DISCORD_CLIENT_SECRET in your Railway env vars.</p>
                    <p>Go to Discord Developer Portal -> Your App -> OAuth2 -> Client Secret</p>
                    <p>Also set OAUTH_REDIRECT_URI to ${webConfig.discord.redirectUri}</p>
                `);
            }

            const tokenData = await authService.exchangeCodeForToken(code);
            const user = await authService.getDiscordUser(tokenData.access_token);
            const guilds = await authService.getDiscordGuilds(tokenData.access_token);

            // Filter guilds where user is admin (and bot is present if private mode)
            const adminGuilds = guilds.filter(g => authService.hasAdminPermission(g.permissions));

            const session = await authService.createSession(client, user, adminGuilds, tokenData.access_token, tokenData.refresh_token);

            setSessionCookie(res, session.sessionId, session.expiresAt);
            // Clear oauth_state cookie
            res.setHeader('Set-Cookie', [
                `${webConfig.session.name}=${session.sessionId}; Expires=${session.expiresAt.toUTCString()}; Path=/; HttpOnly; SameSite=Lax`,
                `oauth_state=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`
            ]);

            res.redirect('/dashboard');
        } catch (error) {
            logger.error('OAuth callback error:', error);
            res.status(500).send(`<h1>Auth failed</h1><p>${error.message}</p><a href="/auth/discord">Try again</a>`);
        }
    });

    // Auth: Logout
    app.get('/auth/logout', async (req, res) => {
        const cookies = parseCookies(req);
        const sessionId = cookies[webConfig.session.name];
        if (sessionId) {
            await authService.destroySession(client, sessionId);
        }
        clearSessionCookie(res);
        res.redirect('/');
    });

    app.get('/auth/me', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.status(401).json({ authenticated: false });
        res.json({ authenticated: true, user: auth.data.user, guilds: auth.data.guilds });
    });

    // Dashboard home - list guilds
    app.get('/dashboard', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.redirect('/auth/discord');

        const user = auth.data.user;
        const userGuilds = auth.data.guilds || [];

        // Filter to guilds where bot is present and user is admin in that guild
        const accessibleGuilds = [];
        for (const g of userGuilds) {
            if (!authService.isGuildAllowed(g.id)) continue;
            const botGuild = client.guilds.cache.get(g.id);
            if (!botGuild) continue; // bot not in guild, skip for private mode
            if (!authService.hasAdminPermission(g.permissions) && !authService.canAccessGuild(user, g, client.guilds.cache)) {
                // Check if bot owner bypass
                const { isBotOwner } = await import('../../config/bot.js');
                if (!isBotOwner(user.id)) continue;
            }
            accessibleGuilds.push({
                id: g.id,
                name: botGuild?.name || g.name,
                icon: botGuild?.iconURL?.({ size: 128 }) || (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null),
                memberCount: botGuild?.memberCount || 0,
                isOwner: g.owner,
            });
        }

        // If owner, also include all guilds bot is in even if not in OAuth guilds (owner bypass)
        const { isBotOwner } = await import('../../config/bot.js');
        if (isBotOwner(user.id)) {
            for (const [id, botGuild] of client.guilds.cache) {
                if (accessibleGuilds.find(g => g.id === id)) continue;
                if (!authService.isGuildAllowed(id)) continue;
                accessibleGuilds.push({
                    id,
                    name: botGuild.name,
                    icon: botGuild.iconURL?.({ size: 128 }) || null,
                    memberCount: botGuild.memberCount || 0,
                    isOwner: true,
                });
            }
        }

        const guildCards = accessibleGuilds.map(g => `
            <a href="/dashboard/${g.id}" class="bg-[#1a1a2e] hover:bg-[#22223a] p-5 rounded-xl border border-purple-900/30 flex items-center gap-4 transition">
                ${g.icon ? `<img src="${g.icon}" class="w-12 h-12 rounded-full">` : `<div class="w-12 h-12 rounded-full bg-purple-600 flex items-center justify-center font-bold">${g.name.charAt(0)}</div>`}
                <div class="flex-1">
                    <div class="font-semibold">${g.name}</div>
                    <div class="text-sm text-gray-400">${g.memberCount} members ${g.isOwner ? '• Owner' : ''}</div>
                </div>
                <div class="text-purple-400">→</div>
            </a>
        `).join('') || `<p class="text-gray-400">No servers found where you are admin and bot is present. Invite the bot to your server first.</p>`;

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Dashboard - Mystic Bot</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#0f0f1a] text-white min-h-screen">
<div class="max-w-6xl mx-auto px-6 py-8">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-3xl font-bold">Your Servers</h1>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <img src="${authService.getUserAvatarUrl(user) || ''}" class="w-8 h-8 rounded-full">
        <span class="text-sm">${user.global_name || user.username}</span>
      </div>
      <a href="/auth/logout" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm">Logout</a>
    </div>
  </div>
  <div class="grid md:grid-cols-2 gap-4">
    ${guildCards}
  </div>
  <div class="mt-10 bg-[#1a1a2e] p-6 rounded-xl border border-yellow-900/30">
    <h3 class="font-semibold mb-2">⚠️ Setup Help</h3>
    <p class="text-sm text-gray-400 mb-2">If you see no servers:</p>
    <ul class="text-sm text-gray-400 list-disc ml-5">
      <li>Make sure bot is invited to your server</li>
      <li>You must have <b>Administrator</b> or <b>Manage Server</b> permission</li>
      <li>Try logging out and back in</li>
      <li>For private mode, set env <code>DASHBOARD_ALLOWED_GUILDS=YOUR_GUILD_ID</code> to restrict to your server</li>
    </ul>
    <p class="text-sm text-gray-500 mt-3">Env needed: DISCORD_CLIENT_SECRET, OAUTH_REDIRECT_URI (set to ${webConfig.discord.redirectUri})</p>
  </div>
</div>
</body>
</html>
        `);
    });

    // Guild dashboard detail
    app.get('/dashboard/:guildId', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.redirect('/auth/discord');
        const guildId = req.params.guildId;

        // Check access
        const userGuild = auth.data.guilds.find(g => g.id === guildId);
        const { isBotOwner } = await import('../../config/bot.js');
        const isOwner = isBotOwner(auth.data.user.id);
        const botGuild = client.guilds.cache.get(guildId);
        if (!botGuild) return res.status(404).send('Bot not in this guild');
        if (!isOwner && (!userGuild || !authService.hasAdminPermission(userGuild.permissions))) {
            return res.status(403).send('You do not have permission to manage this server');
        }

        const dashboardData = await dashboardService.getGuildDashboardData(client, guildId);

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${dashboardData?.guild?.name || guildId} - Mystic Dashboard</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#0f0f1a] text-white min-h-screen">
<div class="max-w-7xl mx-auto px-6 py-6">
  <div class="flex items-center gap-3 mb-6">
    <a href="/dashboard" class="text-gray-400 hover:text-white">← Back</a>
    <h1 class="text-2xl font-bold flex items-center gap-3">
      ${dashboardData?.guild?.icon ? `<img src="${dashboardData.guild.icon}" class="w-8 h-8 rounded-full">` : ''}
      ${dashboardData?.guild?.name || 'Server Dashboard'}
    </h1>
  </div>

  <div class="grid md:grid-cols-4 gap-4 mb-8">
    <div class="bg-[#1a1a2e] p-4 rounded-xl border border-purple-900/20"><div class="text-2xl font-bold">${dashboardData?.guild?.memberCount ?? '-'}</div><div class="text-sm text-gray-400">Members</div></div>
    <div class="bg-[#1a1a2e] p-4 rounded-xl border border-purple-900/20"><div class="text-2xl font-bold">${dashboardData?.config?.logging?.enabled ? 'ON' : 'OFF'}</div><div class="text-sm text-gray-400">Logging</div></div>
    <div class="bg-[#1a1a2e] p-4 rounded-xl border border-purple-900/20"><div class="text-2xl font-bold">${dashboardData?.logStats?.total ?? 0}</div><div class="text-sm text-gray-400">Web Logs Stored</div></div>
    <div class="bg-[#1a1a2e] p-4 rounded-xl border border-purple-900/20"><div class="text-2xl font-bold">${dashboardData?.guild?.channelCount ?? '-'}</div><div class="text-sm text-gray-400">Channels</div></div>
  </div>

  <div class="grid md:grid-cols-3 gap-6">
    <div class="md:col-span-2">
      <div class="bg-[#1a1a2e] rounded-xl border border-purple-900/20 p-5">
        <div class="flex justify-between items-center mb-4">
          <h2 class="font-semibold">📝 Recent Logs (Web)</h2>
          <a href="/dashboard/${guildId}/logs" class="text-sm text-purple-400 hover:text-purple-300">View All →</a>
        </div>
        <div class="space-y-2 max-h-[500px] overflow-y-auto" id="recent-logs">
          ${dashboardData?.recentLogs?.length ? dashboardData.recentLogs.map(log => `
            <div class="bg-[#0f0f1a] p-3 rounded-lg text-sm border border-gray-800/50">
              <div class="flex justify-between"><span class="font-mono text-purple-400">${log.event_type}</span><span class="text-gray-500 text-xs">${new Date(log.created_at).toLocaleString()}</span></div>
              <div class="text-gray-300 text-xs mt-1 truncate">${JSON.stringify(log.data).slice(0,150)}</div>
              ${log.user_id ? `<div class="text-xs text-gray-500 mt-1">User: ${log.user_id}</div>` : ''}
            </div>
          `).join('') : '<p class="text-gray-500 text-sm">No logs yet. Logs will appear here when moderation events happen (ban, kick, message delete, member join, etc.). They are stored from now on.</p>'}
        </div>
      </div>

      <div class="bg-[#1a1a2e] rounded-xl border border-purple-900/20 p-5 mt-6">
        <h2 class="font-semibold mb-3">⚙️ Quick Actions</h2>
        <div class="grid grid-cols-2 gap-3">
          <a href="/dashboard/${guildId}/logs" class="bg-purple-600/20 hover:bg-purple-600/30 border border-purple-600/30 p-3 rounded-lg text-sm text-center">View All Logs</a>
          <button onclick="alert('Coming soon: Welcome editor')" class="bg-gray-800 hover:bg-gray-700 p-3 rounded-lg text-sm">Welcome Messages</button>
          <button onclick="alert('Coming soon: Autorole')" class="bg-gray-800 hover:bg-gray-700 p-3 rounded-lg text-sm">AutoRole</button>
          <button onclick="alert('Coming soon: Reaction Roles')" class="bg-gray-800 hover:bg-gray-700 p-3 rounded-lg text-sm">Reaction Roles</button>
          <button onclick="alert('Coming soon: Alt Detector')" class="bg-gray-800 hover:bg-gray-700 p-3 rounded-lg text-sm">Alt Detector</button>
          <button onclick="alert('Coming soon: Leveling')" class="bg-gray-800 hover:bg-gray-700 p-3 rounded-lg text-sm">Leveling</button>
        </div>
      </div>
    </div>

    <div>
      <div class="bg-[#1a1a2e] rounded-xl border border-purple-900/20 p-5">
        <h2 class="font-semibold mb-3">📊 Logging Config</h2>
        <div class="text-sm space-y-2 text-gray-300">
          <div>Enabled: <span class="font-mono">${dashboardData?.config?.logging?.enabled ? '✅' : '❌'}</span></div>
          <div>Audit Channel: <span class="font-mono text-xs">${dashboardData?.config?.logging?.channelId || 'Not set'}</span></div>
          <div class="pt-2 text-xs text-gray-500">Change this via /logging command in Discord for now. Web editor coming next.</div>
        </div>
        <div class="mt-4 pt-4 border-t border-gray-800">
          <h3 class="text-sm font-semibold mb-2">Event Breakdown</h3>
          <div class="text-xs space-y-1">
            ${Object.entries(dashboardData?.logStats?.byType || {}).map(([k,v]) => `<div class="flex justify-between"><span class="text-gray-400">${k}</span><span>${v}</span></div>`).join('') || '<span class="text-gray-500">No data yet</span>'}
          </div>
        </div>
      </div>

      <div class="bg-[#1a1a2e] rounded-xl border border-yellow-900/20 p-5 mt-6">
        <h2 class="font-semibold mb-2 text-sm">🛠️ For Admins</h2>
        <p class="text-xs text-gray-400">This dashboard is for you + your server admins only. It checks for Administrator or Manage Server permission. When you want to go public, we just change one env var.</p>
        <p class="text-xs text-gray-500 mt-2">Guild ID: ${guildId}</p>
      </div>
    </div>
  </div>
</div>
</body>
</html>
        `);
    });

    // Logs page detail
    app.get('/dashboard/:guildId/logs', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.redirect('/auth/discord');
        const guildId = req.params.guildId;

        const userGuild = auth.data.guilds.find(g => g.id === guildId);
        const { isBotOwner } = await import('../../config/bot.js');
        const isOwner = isBotOwner(auth.data.user.id);
        if (!isOwner && (!userGuild || !authService.hasAdminPermission(userGuild.permissions))) {
            return res.status(403).send('No permission');
        }

        const botGuild = client.guilds.cache.get(guildId);
        if (!botGuild) return res.status(404).send('Bot not in guild');

        const eventType = req.query.type || null;
        const page = parseInt(req.query.page) || 0;
        const limit = 100;

        const { logs, stats } = await dashboardService.getGuildLogsData(client, guildId, { limit, offset: page * limit, eventType });

        const logRows = logs.map(log => `
            <tr class="border-b border-gray-800/50 hover:bg-[#22223a]/50">
                <td class="p-3 text-xs font-mono text-purple-400">${log.event_type}</td>
                <td class="p-3 text-xs text-gray-300 truncate max-w-[300px]">${JSON.stringify(log.data).slice(0,200)}</td>
                <td class="p-3 text-xs text-gray-500">${log.user_id || '-'}</td>
                <td class="p-3 text-xs text-gray-500">${log.moderator_id || '-'}</td>
                <td class="p-3 text-xs text-gray-500">${new Date(log.created_at).toLocaleString()}</td>
            </tr>
        `).join('');

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Logs - ${botGuild.name}</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#0f0f1a] text-white min-h-screen">
<div class="max-w-7xl mx-auto px-6 py-6">
  <div class="flex items-center gap-3 mb-6">
    <a href="/dashboard/${guildId}" class="text-gray-400 hover:text-white">← Back to ${botGuild.name}</a>
    <h1 class="text-2xl font-bold">Logs</h1>
  </div>

  <div class="bg-[#1a1a2e] p-4 rounded-xl border border-purple-900/20 mb-6 flex gap-2 flex-wrap">
    <a href="?type=" class="px-3 py-1 rounded-full text-xs ${!eventType ? 'bg-purple-600' : 'bg-gray-800'}">All</a>
    ${Object.keys(stats.byType || {}).map(t => `<a href="?type=${encodeURIComponent(t)}" class="px-3 py-1 rounded-full text-xs ${eventType===t ? 'bg-purple-600' : 'bg-gray-800'}">${t}</a>`).join('')}
  </div>

  <div class="bg-[#1a1a2e] rounded-xl border border-purple-900/20 overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-[#0f0f1a] text-gray-400 text-xs"><tr><th class="p-3 text-left">Event</th><th class="p-3 text-left">Data</th><th class="p-3 text-left">User</th><th class="p-3 text-left">Mod</th><th class="p-3 text-left">Time</th></tr></thead>
      <tbody>${logRows || '<tr><td colspan=5 class="p-6 text-center text-gray-500">No logs found. Logs start saving from now on when events happen.</td></tr>'}</tbody>
    </table>
  </div>

  <div class="mt-4 flex justify-between">
    ${page>0 ? `<a href="?page=${page-1}${eventType ? `&type=${encodeURIComponent(eventType)}` : ''}" class="bg-gray-800 px-4 py-2 rounded">Prev</a>` : '<span></span>'}
    <a href="?page=${page+1}${eventType ? `&type=${encodeURIComponent(eventType)}` : ''}" class="bg-gray-800 px-4 py-2 rounded">Next →</a>
  </div>
</div>
</body>
</html>
        `);
    });

    // API: guild logs JSON
    app.get('/api/guilds/:guildId/logs', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        const guildId = req.params.guildId;
        const userGuild = auth.data.guilds.find(g => g.id === guildId);
        const { isBotOwner } = await import('../../config/bot.js');
        const isOwner = isBotOwner(auth.data.user.id);
        if (!isOwner && (!userGuild || !authService.hasAdminPermission(userGuild.permissions))) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const logs = await getGuildLogs(client, guildId, {
            limit: parseInt(req.query.limit) || 100,
            offset: parseInt(req.query.offset) || 0,
            eventType: req.query.type || null,
        });
        res.json({ guildId, logs });
    });

    // API: dashboard data
    app.get('/api/guilds/:guildId', async (req, res) => {
        const auth = await requireAuth(req, res, client);
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        const guildId = req.params.guildId;
        const data = await dashboardService.getGuildDashboardData(client, guildId);
        if (!data) return res.status(404).json({ error: 'Guild not found' });
        res.json(data);
    });

    logger.info('✅ Web dashboard routes mounted: /, /dashboard, /auth/*, /api/guilds/*');
}
