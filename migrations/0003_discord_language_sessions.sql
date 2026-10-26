-- Keep setup/unregister sessions and their original kind constraint intact.
-- language retains the exact source value, including unknown legacy codes.
-- The UI falls back for display; only an explicit allowlisted select changes it.
CREATE TABLE discord_language_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    revision INTEGER NOT NULL,
    language TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_language_sessions_expiry ON discord_language_sessions(expires_at);
