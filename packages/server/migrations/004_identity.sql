-- Konten und Identität (NEW_DESIGN.md 9.1, 10.2, 12.4). identities ist die einzige Tabelle mit Twitch-Daten.
CREATE TABLE identities (
  pid          UUID PRIMARY KEY,
  twitch_id    TEXT NOT NULL UNIQUE,
  login        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  pid        UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_pid ON sessions (pid);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Tokens liegen AES-256-GCM-verschlüsselt. Der Schlüssel liegt außerhalb der Datenbank (TOKEN_KEY_FILE).
CREATE TABLE channel_tokens (
  pid           UUID PRIMARY KEY,
  access_token  BYTEA NOT NULL,
  refresh_token BYTEA NOT NULL,
  scopes        TEXT[] NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'invalid')),
  updated_at    TIMESTAMPTZ NOT NULL
);

-- Lesetabelle des Stroms account:<pid>.
CREATE TABLE accounts (
  pid               UUID PRIMARY KEY,
  solo_team_id      UUID NOT NULL UNIQUE,
  terms_version     INTEGER NOT NULL DEFAULT 0,
  channel_connected BOOLEAN NOT NULL DEFAULT false,
  legal             JSONB NOT NULL DEFAULT 'null',
  deleted           BOOLEAN NOT NULL DEFAULT false,
  last_seq          INTEGER NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);
