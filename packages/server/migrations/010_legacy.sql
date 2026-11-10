-- Übernahme des Altbestands (NEW_DESIGN.md 15.6): Zuordnung Alt-ID → Strom, damit ein zweiter Lauf überspringt.
CREATE TABLE legacy_imports (
  legacy_session_id TEXT PRIMARY KEY,
  giveaway_id       UUID NOT NULL,
  imported_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE legacy_teams (
  legacy_team_id TEXT PRIMARY KEY,
  team_id        UUID NOT NULL,
  imported_at    TIMESTAMPTZ NOT NULL
);
