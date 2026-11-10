-- Chat-Ansagen (NEW_DESIGN.md 10.3): der Ingest plant Ansagen aus der Lesetabelle, darum Keyword und Ansage-Einstellungen am Giveaway.
ALTER TABLE giveaways
  ADD COLUMN keyword TEXT,
  ADD COLUMN announcements JSONB NOT NULL DEFAULT '{"muted":false,"links":true,"texts":{}}';
