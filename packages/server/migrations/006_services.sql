-- Rahmen-Dienste (NEW_DESIGN.md 6, 12.4): Zählweise, Löschfrist, Boost am Giveaway; gesehene Teilnehmer je Giveaway.
ALTER TABLE giveaways
  ADD COLUMN counting TEXT NOT NULL DEFAULT 'registered' CHECK (counting IN ('registered', 'first_seen')),
  ADD COLUMN purge_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN purged_at TIMESTAMPTZ,
  ADD COLUMN boost JSONB;

ALTER TABLE giveaway_participants ADD COLUMN seen BOOLEAN NOT NULL DEFAULT false;

-- Der Scheduler sucht Giveaways, deren Löschfrist für Unangemeldete abgelaufen ist.
CREATE INDEX giveaways_purge_due ON giveaways (closed_at) WHERE purged_at IS NULL AND counting = 'first_seen';
