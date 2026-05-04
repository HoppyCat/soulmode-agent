CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT PRIMARY KEY NOT NULL,
  username TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_active INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS bot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT,
  username TEXT,
  message_preview TEXT,
  response_preview TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_files (
  key TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS library_sources (
  key TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS library_cache (
  source_key TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  etag TEXT,
  FOREIGN KEY (source_key) REFERENCES library_sources(key)
);

CREATE TABLE IF NOT EXISTS memory_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  draft TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  target TEXT NOT NULL DEFAULT 'working',
  priority INTEGER NOT NULL DEFAULT 3,
  target_file TEXT NOT NULL DEFAULT 'working_memory',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS coauthor_pins (
  pin TEXT PRIMARY KEY NOT NULL,
  file TEXT NOT NULL,
  snapshot_before TEXT NOT NULL DEFAULT '',
  snapshot_after TEXT NOT NULL DEFAULT '',
  screenshot_url TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source TEXT NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  scale INTEGER NOT NULL,
  visibility TEXT NOT NULL,
  username TEXT,
  created_at INTEGER
);

