-- Operational send reservations only. No destination writes or revision triggers.
CREATE TABLE discord_testmessage_runs (
    interaction_id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_testmessage_target ON discord_testmessage_runs(target_id, issued_at);
CREATE INDEX idx_discord_testmessage_actor ON discord_testmessage_runs(actor_id, issued_at);
CREATE INDEX idx_discord_testmessage_guild ON discord_testmessage_runs(guild_id, issued_at);
CREATE INDEX idx_discord_testmessage_time ON discord_testmessage_runs(issued_at);
