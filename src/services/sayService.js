// sayService.js
//
// Shared logic behind /say, used by both the direct-option path (message
// typed inline) and the popup-modal path (message left blank, opens a
// multi-line text box instead). Keeping this in one place means the actual
// "send it, register it as editable, log it" behavior can never drift
// between the two entry points.

import { logger } from '../utils/logger.js';
import { logEvent } from '../utils/moderation.js';
import { createEditableMessage } from '../utils/database/editableMessages.js';

/**
 * Sends a /say message, optionally registers it as editable, and writes the
 * moderation log entry. Returns the sent message and whether editable
 * registration failed (message still sends even if registration fails).
 */
export async function sendSayMessage({ client, guild, channel, user, message, editable, allowedRoleIds }) {
    const sentMessage = await channel.send({ content: message });

    let registrationFailed = false;
    if (editable) {
        try {
            await createEditableMessage({
                messageId: sentMessage.id,
                guildId: guild.id,
                channelId: channel.id,
                creatorId: user.id,
                allowedRoles: allowedRoleIds,
            });
        } catch (error) {
            registrationFailed = true;
            logger.error(`Failed to register editable message ${sentMessage.id}:`, error);
        }
    }

    await logEvent({
        client,
        guild,
        event: {
            action: 'Bot Message Sent',
            target: `${channel} (${channel.id})`,
            executor: `${user.tag} (${user.id})`,
            reason: message.length > 200 ? `${message.slice(0, 197)}...` : message,
            metadata: {
                channelId: channel.id,
                messageId: sentMessage.id,
                moderatorId: user.id,
                messageLength: message.length,
                editable,
                allowedRoleIds,
            },
        },
    });

    return { sentMessage, registrationFailed };
}

// --- Pending "message left blank" state, bridging /say -> its popup modal ---
//
// Modal submissions arrive as a brand-new interaction with no memory of the
// slash command that opened them, so we stash the resolved channel/editable/
// role choices here (in memory, keyed by the original interaction id) and
// look them back up when the modal is submitted. Auto-expires after 10
// minutes so an abandoned popup can't leak memory.

const pendingSayRequests = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

export function stashPendingSay(token, data) {
    pendingSayRequests.set(token, data);
    const timer = setTimeout(() => pendingSayRequests.delete(token), PENDING_TTL_MS);
    timer.unref?.();
}

export function popPendingSay(token) {
    const data = pendingSayRequests.get(token) ?? null;
    pendingSayRequests.delete(token);
    return data;
}

/** Builds the "Editable via /editmessage by ..." note for the confirmation embed. */
export function buildEditableNote(editable, registrationFailed, allowedRoleIds) {
    if (!editable) return '';
    if (registrationFailed) {
        return '\n\n⚠️ Editing could not be enabled for this message due to a database error — check the bot logs.';
    }
    if (allowedRoleIds.length > 0) {
        return `\n\nEditable via \`/editmessage\` by: ${allowedRoleIds.map((id) => `<@&${id}>`).join(', ')} (and Administrators).`;
    }
    return '\n\nEditable via `/editmessage`, but no roles were selected — only Administrators can use it.';
}
