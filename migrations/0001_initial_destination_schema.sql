-- Application data only. Wrangler maintains its own d1_migrations table.
-- Snowflakes are decimal TEXT: never bind them as JavaScript numbers/BigInts.
CREATE TABLE destinations (
    target_id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    guild_id TEXT,
    eew_alert INTEGER NOT NULL DEFAULT 0,
    eew_prediction INTEGER NOT NULL DEFAULT 0,
    eew_decimation INTEGER NOT NULL DEFAULT 0,
    quake_info INTEGER NOT NULL DEFAULT 0,
    tsunami INTEGER NOT NULL DEFAULT 0,
    min_intensity INTEGER NOT NULL DEFAULT 1,
    lang TEXT NOT NULL DEFAULT 'ja_jp',
    webhook_url TEXT,
    webhook_id TEXT
);

CREATE INDEX idx_destinations_channel_id ON destinations(channel_id);
CREATE INDEX idx_destinations_thread_id ON destinations(thread_id);
CREATE INDEX idx_destinations_guild_id ON destinations(guild_id);
CREATE INDEX idx_destinations_webhook_url ON destinations(webhook_url);
-- Deliberately non-unique, matching the existing Java SQL schema.
CREATE INDEX idx_destinations_webhook_id ON destinations(webhook_id);

CREATE TABLE config_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channels_revision INTEGER NOT NULL DEFAULT 0
        CHECK (channels_revision BETWEEN 0 AND 9007199254740991)
);

INSERT INTO config_meta (id, channels_revision) VALUES (1, 0);

CREATE TABLE data_migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    checksum TEXT NOT NULL DEFAULT '',
    meta TEXT
);
