-- Signalqualität je Kanal (NEW_DESIGN.md 11.2). Betriebsdaten des Ingest, kein Nachweis: nicht im Journal.
CREATE TABLE channel_status (
  pid              UUID PRIMARY KEY,
  live             BOOLEAN NOT NULL DEFAULT false,
  live_since       TIMESTAMPTZ,
  viewers          INTEGER,
  chatters         INTEGER,
  last_signal_at   TIMESTAMPTZ,
  last_presence_at TIMESTAMPTZ,
  problem          TEXT,
  worker           INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL
);

-- Der Ingest sucht offene Giveaways je Kanal: channels @> '["<pid>"]'.
CREATE INDEX giveaways_channels ON giveaways USING GIN (channels jsonb_path_ops);
