# Sticky Messages Module

A complete `/sticky` slash command module for Mystic-Bot: `set`, `edit`, `remove`, `list`, `pause`, `resume`, with automatic threshold-based reposting, an in-memory cache, per-channel mutex locking, and full PostgreSQL persistence with a degraded-mode fallback.

## 1. Installation

No new npm dependencies are required — the module reuses `discord.js`, `pg`, and the project's existing `Mutex`, `logger`, `errorHandler`, `permissionGuard`, and database wrapper utilities.

1. **Pull the files** — see the full list in section 3 below. Nothing outside those files was touched except the four small edits also listed there.
2. **Apply the schema.** The project's schema lives in `src/utils/database/schema.js` (already updated). You have two equivalent options:
   - Just start the bot — `postgresDatabase.js` auto-creates any missing tables/indexes/triggers from `schema.js` on connect.
   - Or run the project's migration script explicitly:
     ```bash
     npm run migrate
     ```
   A standalone reference copy of the generated DDL is also included at `database/migrations/2026_07_25_add_sticky_messages.sql` if you want to review or run it by hand.
3. **Re-deploy slash commands** so Discord picks up the new `/sticky` command (however this project normally does it, e.g. `npm run deploy-commands` / on next startup depending on your deploy strategy).
4. **Restart the bot.** On startup you'll see:
   ```
   Loading sticky messages into cache...
   Sticky messages cached: <N>
   ```

No `.env` changes are needed — it uses the same `DATABASE_URL`/pg config already configured.

## 2. SQL Migration

```sql
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

CREATE TRIGGER update_sticky_messages_updated_at
    BEFORE UPDATE ON sticky_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

This mirrors every column requested: `guild_id`, `channel_id`, `message_content`, `embed_json`, `enabled`, `last_message_id`, `message_counter`, `threshold`, `created_at`, `updated_at`. A `UNIQUE(guild_id, channel_id)` constraint enforces "one sticky per channel" at the database level.

## 3. Files created / modified

### New files

| File | Purpose |
|---|---|
| `src/utils/database/stickyMessages.js` | **Repository layer.** The only file that touches SQL for this feature. Direct `pool.query` against `sticky_messages` when Postgres is reachable; in-memory KV fallback (mirroring the existing `tickets.js` pattern) when it's degraded. Exports `getStickyByChannel`, `listStickiesForGuild`, `getAllStickies`, `createSticky`, `updateSticky` (partial patch, never deletes the row), `deleteSticky`. |
| `src/services/stickyService.js` | **Business logic + cache + concurrency.** Owns the in-memory `Map<channelId, sticky>` cache (loaded once at startup, kept in sync on every write), embed validation/building/rendering, and `handleMessageForSticky()` — the messageCreate hook that increments the counter and triggers reposts, guarded by the project's existing `Mutex` so only one repost ever runs per channel at a time. |
| `src/commands/Sticky/sticky.js` | `/sticky` command router (`ManageGuild` required). Defines all six subcommands' options and dispatches to the modules below. |
| `src/commands/Sticky/modules/sticky_set.js` | `/sticky set` — creates + immediately posts a new sticky. |
| `src/commands/Sticky/modules/sticky_edit.js` | `/sticky edit` — partial update of content/embed/threshold/enabled without deleting the row. |
| `src/commands/Sticky/modules/sticky_remove.js` | `/sticky remove` — deletes the DB row and the live message if it still exists. |
| `src/commands/Sticky/modules/sticky_list.js` | `/sticky list` — lists every sticky in the guild: channel, status, threshold, last repost (derived from the stored Discord message-id snowflake, no extra column needed). |
| `src/commands/Sticky/modules/sticky_pause.js` | `/sticky pause` — sets `enabled = false`. |
| `src/commands/Sticky/modules/sticky_resume.js` | `/sticky resume` — sets `enabled = true`. |
| `database/migrations/2026_07_25_add_sticky_messages.sql` | Human-readable reference copy of the DDL (see note in section 1 — `schema.js` is this project's actual source of truth). |

### Modified files

| File | Change |
|---|---|
| `src/config/database/postgres.js` | Added `sticky_messages` to `pgConfig.tables` and to the `allowedTableIdentifiers` allowlist (required by `sqlIdentifiers.js`'s injection guard before any table name is ever interpolated into SQL). |
| `src/utils/database/schema.js` | Added the `sticky_messages` `CREATE TABLE`, its two indexes, and its `updated_at` trigger registration to the single-source-of-truth arrays (`tableStatements`, `indexStatements`, `triggerDefinitions`). |
| `src/utils/database/keys.js` | Added `getStickyKey(guildId, channelId)` / `getStickyGuildPrefix(guildId)` helpers, used only by the degraded-mode (Postgres-unavailable) fallback path in the repository. |
| `src/events/messageCreate.js` | Added one line calling `handleMessageForSticky(message, client)` for every message, right alongside the existing counting-game hook. |
| `src/app.js` | Added `await initializeStickyCache(this)` during startup, right after the database is ready and before commands are loaded — satisfies "load all stickies on startup" before any message could possibly arrive. |
| `src/config/commands/commandCategories.js` | Added a `📌` icon for the new `Sticky` category (cosmetic only — the loader already infers unknown categories fine without this). |

## 4. How it behaves

- **Ignores** bot messages, webhook messages, and system messages (`isQualifyingMessage()` in `stickyService.js`).
- **Threshold**: `threshold = 1` reposts after every qualifying message; higher values wait for that many messages first. Configurable per sticky via `/sticky set` / `/sticky edit`, clamped 1–500.
- **Repost sequence**: increment counter → once counter reaches threshold → wait ~1s → delete the previous sticky message (ignoring "already deleted" errors) → send the new one → persist the new message id and reset the counter to 0.
- **Cache-first reads**: the messageCreate hot path only ever reads the in-memory `Map`; PostgreSQL is only touched to persist counter increments and on actual reposts/CRUD — never to check "does this channel have a sticky" on every message.
- **Concurrency**: `Mutex.runExclusive('sticky:<channelId>', …)` — a burst of simultaneous messages in the same channel can only ever produce one repost, never a double-post.
- **Embeds**: title, description, color (`#RRGGBB`), thumbnail URL, image URL, footer text, author name, and a live timestamp are all supported. They're rendered via `new EmbedBuilder(rawData)` rather than the fluent `.setFooter()/.setTimestamp()` API, because this project's `utils/embeds.js` globally monkey-patches those two builder methods to silently drop non-"important" footers and all timestamps — using the raw-data constructor bypasses that patch so sticky embeds actually render as configured.
- **Editing** (`/sticky edit`) never deletes the row — it's a targeted `UPDATE` via `stickyMessages.js`'s `updateSticky()`.

## 5. Error handling covered

| Case | Handling |
|---|---|
| Missing `ManageGuild` permission | Enforced natively by Discord via `setDefaultMemberPermissions`. |
| Missing/deleted channel | Explicit `guild.channels.cache.get()` check in every module → friendly `VALIDATION` error. |
| Bot lacks permission to post in the target channel | Checked before creating a sticky (`ensureBotCanPostIn`) and again before every repost. |
| Sticky message already deleted by a moderator | `channel.messages.delete()` failures are caught and logged at `debug` level, never crash the flow. |
| Database failures | Every repository function catches, logs via the project `logger`, and rethrows so callers can decide (commands surface a friendly error; the messageCreate hook logs and continues). |
| Discord API failures / rate limits during repost | Wrapped in try/catch inside `repostSticky()`; failures are logged and the cache/DB are left consistent rather than throwing out of the event handler. |
| Postgres unreachable | Repository transparently falls back to an in-memory KV store (same pattern as `tickets.js`) so the bot keeps functioning in degraded mode. |

## 6. Testing checklist

**Command surface**
- [ ] `/sticky set #channel content:"Welcome!"` creates a plain-text sticky and posts it immediately.
- [ ] `/sticky set` with `title`/`description`/`color`/`thumbnail`/`image`/`footer`/`author`/`timestamp:true` produces a fully-populated embed, including footer and timestamp actually rendering (regression check for the `EmbedBuilder` patch bypass).
- [ ] `/sticky set` on a channel that already has one → friendly "already exists" error, no duplicate row.
- [ ] `/sticky set` with neither content nor any embed field → friendly validation error.
- [ ] `/sticky edit #channel threshold:5` changes only the threshold; content/embed untouched.
- [ ] `/sticky edit #channel enabled:false` pauses via edit (spec requirement).
- [ ] `/sticky edit` on a channel with no sticky → friendly "no sticky configured" error.
- [ ] `/sticky remove #channel` deletes the DB row and the live message.
- [ ] `/sticky remove` when the live message was already manually deleted → still cleans up the DB row without erroring.
- [ ] `/sticky list` shows channel, ✅/⏸️ status, threshold, and a relative "last repost" time for every sticky in the guild.
- [ ] `/sticky pause` then `/sticky resume` round-trips `enabled` correctly.
- [ ] A non-ManageGuild member cannot see/use `/sticky` at all.

**Repost behavior**
- [ ] With `threshold=1`, every qualifying message triggers exactly one repost.
- [ ] With `threshold=3`, the sticky only reposts after the 3rd qualifying message, and the counter visibly resets afterward.
- [ ] Bot messages, webhook messages, and system messages (e.g. pin notifications) never increment the counter or trigger a repost.
- [ ] Rapid-firing many messages at once in the same channel (e.g. a script or multiple users at once) results in exactly one repost, not several (mutex check).
- [ ] Deleting the sticky's live message manually, then sending qualifying messages until threshold — the bot posts fresh without erroring on the missing delete target.
- [ ] Revoking the bot's Send/Embed permission in the channel → repost attempt logs a warning and does not crash the event loop.

**Persistence / restart**
- [ ] Restart the bot with existing stickies in the DB → startup log shows the correct cached count, and reposting resumes immediately without needing to re-run `/sticky set`.
- [ ] Counter values persist across a restart mid-threshold (e.g. counter at 2/5, restart, 3 more messages → reposts).

**Degraded mode** (optional, if you can simulate Postgres being down)
- [ ] With Postgres unreachable, `/sticky set` still works via the in-memory fallback (without surviving a restart), and normal reposting still functions.
