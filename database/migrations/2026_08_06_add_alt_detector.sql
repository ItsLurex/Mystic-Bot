-- Migration: add alt_detect_config and alt_detect_flags tables
-- Generated for the Alt Detector feature (/altdetect).
--
-- NOTE: This project's actual migration mechanism does not use standalone
-- .sql files — src/utils/database/schema.js is the single source of truth,
-- and scripts/migrate.js (`npm run migrate`) applies its tableStatements,
-- indexStatements, and triggerDefinitions directly, in order, wrapped in a
-- transaction. The tables below have already been added to schema.js, so
-- running `npm run migrate` (or simply starting the bot, which auto-creates
-- missing tables on connect) is all that's needed.
--
-- This file is provided purely as a human-readable reference/audit trail of
-- the exact DDL that migration produces, and can be run manually against a
-- database if you prefer not to use the bot's own migration runner.

BEGIN;

CREATE TABLE IF NOT EXISTS alt_detect_config (
    guild_id VARCHAR(20) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    min_account_age_days INTEGER NOT NULL DEFAULT 7,
    action VARCHAR(10) NOT NULL DEFAULT 'alert',   -- alert | kick | ban
    alert_channel_id VARCHAR(20),
    dm_user BOOLEAN NOT NULL DEFAULT TRUE,
    exempt_role_ids JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alt_detect_flags (
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    user_tag VARCHAR(120),
    account_created_at TIMESTAMP,
    account_age_days INTEGER,
    source VARCHAR(10) NOT NULL DEFAULT 'join',    -- join | scan | manual
    status VARCHAR(12) NOT NULL DEFAULT 'flagged', -- flagged | alerted | kicked | banned | cleared
    notes TEXT,
    flagged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alt_detect_flags_guild_id ON alt_detect_flags(guild_id);
CREATE INDEX IF NOT EXISTS idx_alt_detect_flags_status ON alt_detect_flags(guild_id, status);

-- Reuses the project's existing update_updated_at_column() trigger function
-- (already created by earlier migrations / schema.js triggerFunctionSql).
DROP TRIGGER IF EXISTS update_alt_detect_config_updated_at ON alt_detect_config;
CREATE TRIGGER update_alt_detect_config_updated_at
    BEFORE UPDATE ON alt_detect_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_alt_detect_flags_updated_at ON alt_detect_flags;
CREATE TRIGGER update_alt_detect_flags_updated_at
    BEFORE UPDATE ON alt_detect_flags
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;
