-- Ephemeral UI state, never part of the delivery snapshot/revision contract.
CREATE TABLE discord_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('setup', 'unregister')),
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_sessions_expiry ON discord_sessions(expires_at);

-- Discord retries use the same signed interaction ID. Never repeat side effects.
CREATE TABLE discord_interaction_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_receipts_expiry ON discord_interaction_receipts(expires_at);

-- Serialize webhook discovery/creation across a parent and all its threads.
-- No unique constraint is added to legacy destinations.webhook_id.
CREATE TABLE discord_setup_locks (
    channel_id TEXT PRIMARY KEY NOT NULL,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
