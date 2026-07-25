import { pgDb } from '../utils/postgresDatabase.js';

async function ensureConnected() {
  if (!pgDb.isAvailable()) {
    const connected = await pgDb.connect();

    if (!connected || !pgDb.isAvailable()) {
      throw new Error('PostgreSQL is not available.');
    }
  }

  return pgDb.pool;
}

export async function saveEditableMessage({
  guildId,
  channelId,
  messageId,
  roleIds,
  createdBy,
}) {
  const pool = await ensureConnected();

  await pool.query(
    `INSERT INTO editable_messages
      (guild_id, channel_id, message_id, role_ids, created_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (message_id)
     DO UPDATE SET
       channel_id = $2,
       role_ids = $4::jsonb,
       created_by = $5,
       updated_at = CURRENT_TIMESTAMP`,
    [
      guildId,
      channelId,
      messageId,
      JSON.stringify(roleIds),
      createdBy,
    ],
  );
}

export async function getEditableMessage(messageId) {
  const pool = await ensureConnected();

  const result = await pool.query(
    `SELECT
       guild_id,
       channel_id,
       message_id,
       role_ids,
       created_by
     FROM editable_messages
     WHERE message_id = $1`,
    [messageId],
  );

  return result.rows[0] ?? null;
}

export async function deleteEditableMessage(messageId) {
  const pool = await ensureConnected();

  await pool.query(
    `DELETE FROM editable_messages WHERE message_id = $1`,
    [messageId],
  );
}

export function hasAllowedRole(member, roleIds = []) {
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}
