-- Simplification (2026-10-31): Discord interactions no longer keep receipts,
-- sessions or setup locks, /testmessage has one per-target cooldown, and the
-- earthquake publication keeps only the latest report.

DROP TABLE interaction_receipts;
DROP TABLE discord_sessions;
DROP TABLE discord_setup_locks;
DROP TABLE discord_testmessage_runs;

DROP TABLE quake_snapshot_messages;
DROP TABLE quake_snapshot_manifest;
DROP TABLE quake_latest;
DROP TABLE quake_snapshots;
DROP TABLE quake_publisher_leases;
DROP TABLE quake_publisher_state;

-- /testmessage cooldown: one row per target, overwritten once the cooldown passed.
CREATE TABLE testmessage_cooldowns (
    target_id TEXT PRIMARY KEY NOT NULL,
    until     INTEGER NOT NULL
);

-- The single latest report published by Java Core. `snapshot_id` changes on
-- every accepted write so that messages of the replaced report can be dropped
-- in the same transaction.
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
    updated_at         INTEGER NOT NULL
);

CREATE TABLE quake_messages (
    snapshot_id   TEXT NOT NULL,
    lang          TEXT NOT NULL CHECK (lang IN ('ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp')),
    message_index INTEGER NOT NULL CHECK (message_index BETWEEN 0 AND 15),
    embeds_json   TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, lang, message_index)
);
