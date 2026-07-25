-- Migration: add sticky_messages table
-- Generated for the Sticky Messages feature.
--
-- NOTE: This project's actual migration mechanism does not use standalone
-- .sql files — src/utils/database/schema.js is the single source of truth,
-- and scripts/migrate.js (`npm run migrate`) applies its tableStatements,
-- indexStatements, and triggerDefinitions directly, in order, wrapped in a
-- transaction. The table below has already been added to schema.js, so
-- running `npm run migrate` (or simply starting the bot, which auto-creates
-- missing tables on connect) is all that's needed.
--
-- This file is provided purely as a human-readable reference/audit trail of
-- the exact DDL that migration produces, and can be run manually against a
-- database if you prefer not to use the bot's own migration runner.

BEGIN;

CREATE TABLE IF NOT EXISTS sticky_messages (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    message_content TEXT,
    embed_json JSONB,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_message_id VARCHAR(20),
    message_counter INTEGER NOT NULL DEFAULT 0,
    threshold INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
    UNIQUE (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_sticky_messages_guild_id ON sticky_messages(guild_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sticky_messages_channel_id ON sticky_messages(channel_id);

-- Reuses the project's existing update_updated_at_column() trigger function
-- (already created by earlier migrations / schema.js triggerFunctionSql).
DROP TRIGGER IF EXISTS update_sticky_messages_updated_at ON sticky_messages;
CREATE TRIGGER update_sticky_messages_updated_at
    BEFORE UPDATE ON sticky_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;
