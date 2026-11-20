CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  destination TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  clicks INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX links_owner_created ON links(owner_hash, id DESC);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
