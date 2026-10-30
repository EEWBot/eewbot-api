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
    -- Java SeismicIntensity codes: 0 unknown, 1..9 = intensity 1 .. 7.
    min_intensity  INTEGER NOT NULL DEFAULT 1 CHECK (min_intensity BETWEEN 0 AND 9),
    lang           TEXT NOT NULL DEFAULT 'ja_jp'
        CHECK (lang IN ('ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp')),
    -- Sensitive: the token is a Discord credential. The URL is derived in code.
    webhook_id     TEXT,
    webhook_token  TEXT,
    CHECK ((webhook_id IS NULL) = (webhook_token IS NULL)),
    -- A thread destination is keyed by the thread; a channel destination by the channel.
    CHECK (thread_id IS NULL OR thread_id = target_id),
    CHECK (thread_id IS NOT NULL OR channel_id = target_id)
);
CREATE INDEX idx_destinations_guild_id ON destinations (guild_id);
CREATE INDEX idx_destinations_channel_id ON destinations (channel_id);
-- Non-unique: a parent channel and its threads share one channel webhook.
CREATE INDEX idx_destinations_webhook_id ON destinations (webhook_id);

-- Single-row monotonically increasing configuration revision.
CREATE TABLE config_meta (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    channels_revision INTEGER NOT NULL DEFAULT 0
        CHECK (channels_revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO config_meta (id, channels_revision) VALUES (1, 0);

-- Discord interaction state (never part of the delivery snapshot) -----------

-- Discord redelivers the same signed interaction ID. Every deferred command
-- claims it once here before any side effect.
CREATE TABLE interaction_receipts (
    interaction_id TEXT PRIMARY KEY NOT NULL,
    expires_at     INTEGER NOT NULL
);
CREATE INDEX idx_interaction_receipts_expiry ON interaction_receipts (expires_at);

-- Short-lived component sessions for the /setup, /unregister and /lang menus.
CREATE TABLE discord_sessions (
    id         TEXT PRIMARY KEY NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('setup', 'unregister', 'lang')),
    actor_id   TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id  TEXT,
    revision   INTEGER NOT NULL,
    language   TEXT,
    expires_at INTEGER NOT NULL,
    CHECK ((kind = 'lang') = (language IS NOT NULL))
);
CREATE INDEX idx_discord_sessions_expiry ON discord_sessions (expires_at);

-- Serializes webhook discovery/creation across a parent channel and its threads.
CREATE TABLE discord_setup_locks (
    channel_id TEXT PRIMARY KEY NOT NULL,
    owner      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_discord_setup_locks_expiry ON discord_setup_locks (expires_at);

-- /testmessage rate-limit ledger.
CREATE TABLE discord_testmessage_runs (
    interaction_id TEXT PRIMARY KEY NOT NULL,
    actor_id       TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    guild_id       TEXT NOT NULL,
    issued_at      INTEGER NOT NULL
);
CREATE INDEX idx_testmessage_target ON discord_testmessage_runs (target_id, issued_at);
CREATE INDEX idx_testmessage_actor ON discord_testmessage_runs (actor_id, issued_at);
CREATE INDEX idx_testmessage_guild ON discord_testmessage_runs (guild_id, issued_at);
CREATE INDEX idx_testmessage_time ON discord_testmessage_runs (issued_at);

-- Earthquake information snapshots -------------------------------------------

CREATE TABLE quake_publisher_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    publisher_epoch INTEGER NOT NULL DEFAULT 0
);
INSERT INTO quake_publisher_state (id) VALUES (1);

CREATE TABLE quake_publisher_leases (
    publisher_id    TEXT PRIMARY KEY NOT NULL,
    publisher_epoch INTEGER NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL
);

CREATE TABLE quake_snapshots (
    snapshot_id        TEXT PRIMARY KEY NOT NULL,
    schema_version     INTEGER NOT NULL CHECK (schema_version = 1),
    event_id           TEXT NOT NULL,
    report_type        TEXT NOT NULL,
    report_date_time   TEXT,
    date_time          TEXT,
    serial             INTEGER NOT NULL,
    info_type          TEXT NOT NULL,
    info_type_priority INTEGER NOT NULL CHECK (info_type_priority BETWEEN 0 AND 2),
    is_cancel          INTEGER NOT NULL CHECK (is_cancel IN (0, 1)),
    rendered_at        TEXT NOT NULL,
    content_hash       TEXT NOT NULL,
    request_hash       TEXT NOT NULL,
    publisher_epoch    INTEGER NOT NULL,
    publisher_sequence INTEGER NOT NULL,
    expected_messages  INTEGER NOT NULL,
    expected_bytes     INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'committed')),
    created_at         INTEGER NOT NULL,
    committed_at       INTEGER,
    retired_at         INTEGER,
    UNIQUE (publisher_epoch, publisher_sequence)
);
CREATE INDEX idx_quake_snapshots_cleanup ON quake_snapshots (status, created_at);

CREATE TABLE quake_snapshot_manifest (
    snapshot_id   TEXT NOT NULL REFERENCES quake_snapshots (snapshot_id) ON DELETE CASCADE,
    lang          TEXT NOT NULL CHECK (lang IN ('ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp')),
    message_index INTEGER NOT NULL CHECK (message_index BETWEEN 0 AND 15),
    content_hash  TEXT NOT NULL,
    byte_length   INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 65536),
    PRIMARY KEY (snapshot_id, lang, message_index)
);

CREATE TABLE quake_snapshot_messages (
    snapshot_id   TEXT NOT NULL REFERENCES quake_snapshots (snapshot_id) ON DELETE CASCADE,
    lang          TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    embeds_json   TEXT NOT NULL CHECK (length(CAST(embeds_json AS BLOB)) <= 65536),
    content_hash  TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, lang, message_index),
    FOREIGN KEY (snapshot_id, lang, message_index)
        REFERENCES quake_snapshot_manifest (snapshot_id, lang, message_index)
);

CREATE TABLE quake_latest (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot_id    TEXT REFERENCES quake_snapshots (snapshot_id),
    quake_revision INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER
);
INSERT INTO quake_latest (id) VALUES (1);
