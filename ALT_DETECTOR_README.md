# Alt Detector Module

A complete `/altdetect` slash command module for Mystic-Bot: detect suspected alt accounts (Discord accounts younger than a configurable age) at join time or on demand, with per-guild config (threshold, alert/kick/ban action, alert channel, DM toggle, exempt roles), a persistent flag history, automatic flag bookkeeping on bans via the new `guildBanAdd` event, and full PostgreSQL persistence with a degraded-mode fallback.

## 1. Installation

No new npm dependencies are required — the module reuses `discord.js`, `pg`, and the project's existing `logger`, `errorHandler`, `InteractionHelper`, embed helpers, and database wrapper utilities, plus `ModerationService` for case-logged kicks/bans.

1. **Pull the files** — see the full list in section 3 below. Nothing outside those files was touched except the five small edits also listed there.
2. **Apply the schema.** The project's schema lives in `src/utils/database/schema.js` (already updated). You have two equivalent options:
   - Just start the bot — `postgresDatabase.js` auto-creates any missing tables/indexes/triggers from `schema.js` on connect.
   - Or run the project's migration script explicitly:
     ```bash
     npm run migrate
     ```
   A standalone reference copy of the generated DDL is also included at `database/migrations/2026_08_06_add_alt_detector.sql` if you want to review or run it by hand.
3. **Re-deploy slash commands** so Discord picks up the new `/altdetect` command (the bot registers its commands globally on startup, so a restart is normally enough).
4. **Restart the bot.** On startup you'll see:
   ```
   [AltDetect] Loaded <N> guild config(s) into cache
   ```

No `.env` changes are needed — it uses the same `DATABASE_URL`/pg config already configured.

## 2. SQL Migration

```sql
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

CREATE TRIGGER update_alt_detect_config_updated_at
    BEFORE UPDATE ON alt_detect_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alt_detect_flags_updated_at
    BEFORE UPDATE ON alt_detect_flags
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

`alt_detect_config` stores one row per guild (the feature defaults live in code — a guild with no row behaves as disabled with a 7-day threshold). `alt_detect_flags` stores one row per (guild, user) that has ever been flagged: how it was detected (`source`), what happened to it (`status`), the account's age at detection time, and when it was flagged/resolved. A `PRIMARY KEY (guild_id, user_id)` enforces "one flag per user per server" at the database level; re-detections update the existing row instead of duplicating it.

## 3. Files created / modified

### New files

| File | Purpose |
|---|---|
| `src/utils/database/altDetect.js` | **Repository layer.** The only file that touches SQL for this feature. Direct `pool.query` against `alt_detect_config` / `alt_detect_flags` when Postgres is reachable; key-value fallback via the shared database wrapper (mirroring the existing `trapBanRules.js` pattern) when it's degraded. Exports `getConfig`, `getAllConfigs`, `saveConfig`, `upsertFlag`, `getFlag`, `listFlags`, `removeFlag`. |
| `src/services/altDetectService.js` | **Business logic + cache.** Owns the in-memory `Map<guildId, config>` cache (warmed at startup, kept in sync on every write), account-age math, exempt-role checks, alert-channel delivery, `handleMemberJoin()` (the join-time check that applies the configured action), `scanGuild()` (the report-only on-demand scan), `handleGuildBanAdd()` (flag bookkeeping when a flagged user is banned), and `clearFlag()`/`removeFlag()` for staff review workflows. Automatic kicks/bans go through the project's existing `ModerationService` so they get normal moderation case logging. |
| `src/commands/Security/altdetect.js` | The `/altdetect` command (`BanMembers` required): `status`, `enable`, `disable`, `threshold`, `action`, `channel`, `dm`, `exempt`, `unexempt`, `scan`, `list`, `clear`, `unflag`. Creates the new `Security` command category (the loader infers the category from the folder name). |
| `src/events/guildBanAdd.js` | New `guildBanAdd` event: hands every ban to `handleGuildBanAdd()` so flagged alts that get banned (by staff or by the detector itself) move to the terminal `banned` status with the ban's audit reason attached. |
| `database/migrations/2026_08_06_add_alt_detector.sql` | Human-readable reference copy of the DDL (see note in section 1 — `schema.js` is this project's actual source of truth). |
| `ALT_DETECTOR_README.md` | This file. |

### Modified files

| File | Change |
|---|---|
| `src/config/database/postgres.js` | Added `alt_detect_config` and `alt_detect_flags` to `pgConfig.tables` and to the `allowedTableIdentifiers` allowlist (required by `sqlIdentifiers.js`'s injection guard before any table name is ever interpolated into SQL). |
| `src/utils/database/schema.js` | Added the two `CREATE TABLE` statements, their indexes, and their `updated_at` trigger registrations to the single-source-of-truth arrays (`tableStatements`, `indexStatements`, `triggerDefinitions`). |
| `src/events/guildMemberAdd.js` | Added one guarded call to `handleMemberJoin(member)` at the top of the join pipeline. If it returns `true` (the member was auto-kicked/banned), the rest of the pipeline (welcome, auto-role, counters…) is skipped for that member. |
| `src/events/ready.js` | Added `await initAltDetectCache()` next to the existing `initIgnoredRolesCache()` call so all guild configs are cached before any join event can arrive. |
| `src/config/commands/commandCategories.js` | Added a `🕵️` icon for the new `Security` category (cosmetic only — the loader already infers unknown categories fine without this). |

## 4. How it behaves

- **Per-guild config, cached**: configs are loaded into memory at startup and refreshed on every write; the join-time hot path reads the cache, not Postgres.
- **Join-time check** (`handleMemberJoin`, runs for every non-bot join when the detector is enabled):
  - Cleared (`/altdetect clear`) and exempt-role members are never touched.
  - Accounts **at or above** the threshold pass silently.
  - Accounts **under** the threshold get the configured action: `alert` (flag + notify the alert channel, no removal), `kick`, or `ban` — kicks/bans run through `ModerationService`, so they appear in the normal moderation case log, and an optional DM explains what happened before it happens.
  - If enforcement fails (missing permissions, hierarchy, race), the user is still flagged and the alert channel is told why — the failure never blocks the rest of the join pipeline.
- **Rejoin awareness**: if a previously *banned* flag rejoins, the detector alerts the channel ("previously banned account rejoined") but takes no automatic action — ban-evasion stays a human decision.
- **Scan is report-only**: `/altdetect scan` fetches the full member list, flags accounts under the threshold (status `flagged`, source `scan`), and replies with a sorted report. It never kicks or bans anyone, and it skips accounts a staffer already cleared.
- **Ban bookkeeping** (`guildBanAdd`): whenever a flagged user is banned, their flag moves to status `banned` with the audit-log reason attached and `resolved_at` stamped; if the detector is enabled, the alert channel gets a confirmation embed. Unflagged users are ignored — the flag table only ever contains detector history.
- **One flag per user per guild**: repeat detections `UPSERT` the existing row (keeping the original `source` and `flagged_at`) rather than duplicating history.

## 5. Error handling covered

| Case | Handling |
|---|---|
| Missing `BanMembers` permission | Enforced natively by Discord via `setDefaultMemberPermissions` (the feature can kick/ban, so it's gated at the highest level it uses). |
| Missing/deleted alert channel | Resolved and permission-checked (`View/Send/EmbedLinks`) before every alert; undeliverable alerts are logged and dropped, never thrown. |
| User has DMs closed / blocked the bot | DM attempts are caught and ignored — a failed DM never stops the kick/ban itself. |
| Kick/ban fails (permissions, hierarchy, race) | Caught per-action; the member is flagged as `alerted` instead and the alert channel explains the failure. |
| Ban audit reason not fetchable | `guild.bans.fetch()` failures are caught; the flag is still updated without the reason text. |
| Full member fetch fails during a scan | Falls back to the cached member collection with a logged warning. |
| Database failures | Every repository function catches, logs via the project `logger`, and rethrows (commands surface a friendly error) or degrades gracefully (event hooks log and continue). The join/ban hooks themselves never throw into the event loop. |
| Postgres unreachable | Repository transparently falls back to the key-value store (same pattern as `trapBanRules.js`) so the bot keeps functioning in degraded mode. |

## 6. Testing checklist

**Command surface**
- [ ] `/altdetect status` shows enabled state, threshold, action, alert channel, DM toggle, exempt roles, and flag counts.
- [ ] `/altdetect enable` then `/altdetect disable` round-trips correctly (and each reports "already …" when nothing changed).
- [ ] `/altdetect threshold days:14` persists and appears in `status`.
- [ ] `/altdetect action mode:alert|kick|ban` persists; invalid modes are rejected by Discord's choices.
- [ ] `/altdetect channel #channel` sets the alert channel; running it with no channel clears it.
- [ ] `/altdetect dm enabled:false` stops pre-action DMs.
- [ ] `/altdetect exempt @role` and `/altdetect unexempt @role` add/remove roles; duplicates and missing entries produce friendly errors.
- [ ] `/altdetect clear @user` marks them reviewed (they're never flagged again); `/altdetect unflag @user` deletes the record; both error friendly on users with no flag.
- [ ] A non-BanMembers member cannot see/use `/altdetect` at all.

**Detection behavior**
- [ ] With the detector enabled and threshold 7: a 1-day-old account joining gets the configured action; a 30-day-old account joins untouched.
- [ ] Action `alert`: the young account stays in the server, is flagged, and the alert channel gets an embed.
- [ ] Action `kick`/`ban`: the young account is removed, the moderation case log shows the detector as executor, and (with DM on) the user received a DM first.
- [ ] A member holding an exempt role is never flagged or actioned regardless of account age.
- [ ] `/altdetect scan` flags young members, skips bots and cleared accounts, and never removes anyone.
- [ ] `/altdetect list` shows every flag with status icons and detection source.

**Ban bookkeeping**
- [ ] Manually banning a flagged user updates their flag to `banned` (visible in `/altdetect list`) with the audit reason, and posts a confirmation to the alert channel.
- [ ] A user banned by the detector itself on join ends up with a `banned` flag exactly once (no duplicate flag from the `guildBanAdd` echo).
- [ ] Re-inviting a previously banned flagged user triggers the "previously banned account rejoined" alert without any automatic punishment.

**Persistence / restart**
- [ ] Restart the bot with existing configs in the DB → startup log shows the correct cached count, and detection resumes immediately without re-running any setup command.

**Degraded mode** (optional, if you can simulate Postgres being down)
- [ ] With Postgres unreachable, config changes and flags still work via the key-value fallback (without surviving a restart), and join-time detection keeps functioning.
