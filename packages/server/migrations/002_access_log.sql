CREATE TABLE access_log (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('read', 'denied')),
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  reason   TEXT,
  target   TEXT,
  ip       INET,
  count    INTEGER NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL,
  last_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX access_log_throttle ON access_log (actor, action, reason, first_at) WHERE kind = 'denied';
CREATE INDEX access_log_last_at_ip ON access_log (last_at) WHERE ip IS NOT NULL;
