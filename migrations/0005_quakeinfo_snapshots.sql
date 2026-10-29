CREATE TABLE quake_publisher_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    publisher_epoch INTEGER NOT NULL DEFAULT 0
);
INSERT INTO quake_publisher_state (id) VALUES (1);

CREATE TABLE quake_publisher_leases (
    publisher_id TEXT PRIMARY KEY,
    publisher_epoch INTEGER NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE quake_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    event_id TEXT NOT NULL,
    report_type TEXT NOT NULL,
    report_date_time TEXT,
    date_time TEXT,
    serial INTEGER NOT NULL,
    info_type TEXT NOT NULL,
    info_type_priority INTEGER NOT NULL CHECK (info_type_priority BETWEEN 0 AND 2),
    is_cancel INTEGER NOT NULL CHECK (is_cancel IN (0, 1)),
    rendered_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    publisher_epoch INTEGER NOT NULL,
    publisher_sequence INTEGER NOT NULL,
    expected_messages INTEGER NOT NULL,
    expected_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'committed')),
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    retired_at INTEGER,
    UNIQUE (publisher_epoch, publisher_sequence)
);
CREATE INDEX quake_snapshots_cleanup ON quake_snapshots (status, created_at);

CREATE TABLE quake_snapshot_manifest (
    snapshot_id TEXT NOT NULL REFERENCES quake_snapshots(snapshot_id) ON DELETE CASCADE,
    lang TEXT NOT NULL CHECK (lang IN ('ja_jp','en_us','zh_tw','ko_hanja','ko_kp')),
    message_index INTEGER NOT NULL CHECK (message_index BETWEEN 0 AND 15),
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 65536),
    PRIMARY KEY (snapshot_id, lang, message_index)
);

CREATE TABLE quake_snapshot_messages (
    snapshot_id TEXT NOT NULL REFERENCES quake_snapshots(snapshot_id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    embeds_json TEXT NOT NULL CHECK (length(CAST(embeds_json AS BLOB)) <= 65536),
    content_hash TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, lang, message_index),
    FOREIGN KEY (snapshot_id, lang, message_index)
        REFERENCES quake_snapshot_manifest(snapshot_id, lang, message_index)
);

CREATE TABLE quake_latest (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot_id TEXT REFERENCES quake_snapshots(snapshot_id),
    quake_revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
);
INSERT INTO quake_latest (id) VALUES (1);

-- A signed Discord interaction is claimed once, without changing configuration.
CREATE TABLE quake_interactions (
    interaction_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
