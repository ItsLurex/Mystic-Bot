// discordInputParsing.js
//
// Shared parsing helpers for commands that accept Discord entities as typed
// text instead of Discord's native picker components. Used specifically to
// work around Discord's role-select restriction: any addRoleOption picker
// (and RoleSelectMenu component) hides roles at or above the *invoking
// member's own* highest role, unless that member has Administrator — even
// if the bot's own role sits above those roles. Accepting a typed mention
// or raw ID via a plain string option sidesteps that restriction entirely.

/**
 * Resolves a role from typed input: a mention like `<@&123456789012345678>`
 * or a raw role id. Returns the Role object, or null if not found/invalid.
 */
export function resolveRoleFromInput(guild, input) {
    if (!input) return null;
    const trimmed = input.trim();
    const mentionMatch = /^<@&(\d+)>$/.exec(trimmed);
    const roleId = mentionMatch ? mentionMatch[1] : trimmed;

    if (!/^\d{15,25}$/.test(roleId)) return null;
    return guild.roles.cache.get(roleId) || null;
}
