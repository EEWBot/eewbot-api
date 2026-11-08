-- EEWBot API schema. Wrangler maintains its own d1_migrations table.
-- Conventions:
--   * Snowflakes are canonical decimal TEXT; never bind them as JavaScript numbers.
--   * Every timestamp is Unix epoch milliseconds (INTEGER), bound from the Worker.
--   * Booleans are INTEGER 0/1 with a CHECK constraint.

-- Delivery configuration ----------------------------------------------------

CREATE TABLE destinations (
    target_id      TEXT PRIMARY KEY NOT NULL,
    guild_id       TEXT,
    channel_id     TEXT NOT NULL,
    thread_id      TEXT,
    eew_alert      INTEGER NOT NULL DEFAULT 0 CHECK (eew_alert IN (0, 1)),
    eew_prediction INTEGER NOT NULL DEFAULT 0 CHECK (eew_prediction IN (0, 1)),
    eew_decimation INTEGER NOT NULL DEFAULT 0 CHECK (eew_decimation IN (0, 1)),
    quake_info     INTEGER NOT NULL DEFAULT 0 CHECK (quake_info IN (0, 1)),
    tsunami        INTEGER NOT NULL DEFAULT 0 CHECK (tsunami IN (0, 1)),
    -- Java SeismicIntensity codes: 0 unknown (no filter), 1..9 = intensity 1 .. 7.
    min_intensity  INTEGER NOT NULL DEFAULT 0 CHECK (min_intensity BETWEEN 0 AND 9),
    lang           TEXT NOT NULL DEFAULT 'ja_jp',
    -- Sensitive: the token is a Discord credential. The URL is derived in code.
    webhook_id     TEXT,
    webhook_token  TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    CHECK ((webhook_id IS NULL) = (webhook_token IS NULL)),
    -- A thread destination is keyed by the thread; a channel destination by the channel.
    CHECK (thread_id IS NULL OR thread_id = target_id),
    CHECK (thread_id IS NOT NULL OR channel_id = target_id)
);
CREATE INDEX idx_destinations_guild_id ON destinations (guild_id);
-- Non-unique: a parent channel and its threads share one channel webhook.
CREATE INDEX idx_destinations_webhook_id ON destinations (webhook_id);

-- Single-row monotonically increasing configuration revision.
CREATE TABLE config_meta (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    channels_revision INTEGER NOT NULL DEFAULT 0
        CHECK (channels_revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO config_meta (id, channels_revision) VALUES (1, 0);

-- /testmessage cooldown: one row per target, overwritten once the cooldown passed.
CREATE TABLE testmessage_cooldowns (
    target_id TEXT PRIMARY KEY NOT NULL,
    until     INTEGER NOT NULL
);

-- The single latest report published by Java Core. `snapshot_id` changes on
-- every accepted write so that messages of the replaced report can be dropped
-- in the same transaction. `content_hash` lets an identical re-publication
-- leave the row (and its revision) untouched.
CREATE TABLE quake_latest (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot_id        TEXT NOT NULL,
    revision           INTEGER NOT NULL,
    event_id           TEXT NOT NULL,
    report_type        TEXT NOT NULL,
    report_date_time   TEXT,
    date_time          TEXT,
    serial             INTEGER NOT NULL,
    info_type          TEXT NOT NULL,
    info_type_priority INTEGER NOT NULL CHECK (info_type_priority BETWEEN 0 AND 2),
    content_hash       TEXT NOT NULL,
    updated_at         INTEGER NOT NULL
);

CREATE TABLE quake_messages (
    snapshot_id   TEXT NOT NULL,
    lang          TEXT NOT NULL,
    message_index INTEGER NOT NULL CHECK (message_index >= 0),
    embeds_json   TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, lang, message_index)
);
