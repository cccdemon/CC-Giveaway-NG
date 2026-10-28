CREATE TABLE giveaways (
  id UUID PRIMARY KEY, team_id UUID NOT NULL, kernel TEXT NOT NULL, kernel_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','open','paused','closed','drawn','completed','cancelled')),
  prize TEXT NOT NULL, sponsor TEXT, winners_count INTEGER NOT NULL, claim_days INTEGER NOT NULL, config JSONB NOT NULL, channels JSONB NOT NULL, gates JSONB NOT NULL,
  registered_count INTEGER NOT NULL DEFAULT 0, pool_size INTEGER NOT NULL DEFAULT 0, pool_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX giveaways_team_status ON giveaways (team_id, status);
CREATE TABLE giveaway_participants (
  giveaway_id UUID NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE, pid UUID NOT NULL,
  registered BOOLEAN NOT NULL, in_pool BOOLEAN NOT NULL, weight DOUBLE PRECISION NOT NULL, winner_status TEXT,
  PRIMARY KEY (giveaway_id, pid)
);
CREATE TABLE timers (
  stream TEXT NOT NULL, key TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL, command JSONB NOT NULL,
  PRIMARY KEY (stream, key)
);
CREATE INDEX timers_due ON timers (due_at);
