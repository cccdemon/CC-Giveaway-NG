-- Plattform-Verwaltung (NEW_DESIGN.md 5.1, 11.4, 12.4): Lesetabellen des Stroms platform und Betriebsdaten.
CREATE TABLE platform_bans (
  pid      UUID PRIMARY KEY,
  reason   TEXT NOT NULL,
  since    TIMESTAMPTZ NOT NULL,
  event_id TEXT NOT NULL
);

CREATE TABLE platform_warnings (
  event_id  TEXT PRIMARY KEY,
  pid       UUID NOT NULL,
  reason    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  withdrawn BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX platform_warnings_pid ON platform_warnings (pid);

CREATE TABLE platform_terms (
  version      INTEGER PRIMARY KEY,
  text         TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL
);

-- Browser-Fehler ohne Personenbezug, 30 Tage (12.4). Kein Nachweis, kein Journal.
CREATE TABLE browser_errors (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL,
  message    TEXT NOT NULL,
  stack      TEXT,
  url        TEXT,
  user_agent TEXT
);
CREATE INDEX browser_errors_at ON browser_errors (at);

-- Rückmeldungen der Nutzer (11.4). Pseudonym pid, Freitext. Kein Journal.
CREATE TABLE feedback (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pid  UUID NOT NULL,
  text TEXT NOT NULL,
  at   TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX feedback_done_at ON feedback (done, at DESC);
