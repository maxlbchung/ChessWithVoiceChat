-- D1 schema for the matchmaker. Apply with:
--   npx wrangler d1 execute chess-matchmaker --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS waiting (
  ticket          TEXT PRIMARY KEY,
  time_control_id TEXT NOT NULL,
  peer_id         TEXT NOT NULL,
  public_key_hex  TEXT NOT NULL,
  handle          TEXT NOT NULL,
  rating          INTEGER NOT NULL,
  joined_at       INTEGER NOT NULL
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
