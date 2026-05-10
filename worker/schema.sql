-- D1 schema for the matchmaker. Apply with:
--   npx wrangler d1 execute chess-matchmaker --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS waiting (
  ticket          TEXT PRIMARY KEY,
  time_control_id TEXT NOT NULL,
  peer_id         TEXT NOT NULL,
  public_key_hex  TEXT NOT NULL,
  handle          TEXT NOT NULL,
  rating          INTEGER NOT NULL,
  joined_at       INTEGER NOT NULL,
  -- Heartbeat: client bumps this on every poll so we can tell the difference
  -- between an active waiter and a closed-tab ghost. gc prunes anyone with a
  -- stale last_seen_at, well before the join_at-based 120s safety net.
  last_seen_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_waiting_tc_joined
  ON waiting(time_control_id, joined_at);

CREATE TABLE IF NOT EXISTS matched (
  ticket            TEXT PRIMARY KEY,
  partner_peer_id   TEXT NOT NULL,
  partner_pub_key   TEXT NOT NULL,
  partner_handle    TEXT NOT NULL,
  partner_rating    INTEGER NOT NULL,
  i_am_white        INTEGER NOT NULL,
  game_id           TEXT NOT NULL,
  expires_at        INTEGER NOT NULL
);

-- Append-only log of every queue join. Powers the home-page activity counts
-- ("N joined in the last 10 min"). Rows are GC'd past the longest window.
CREATE TABLE IF NOT EXISTS queue_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  time_control_id TEXT NOT NULL,
  joined_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_log_tc_joined
  ON queue_log(time_control_id, joined_at);
