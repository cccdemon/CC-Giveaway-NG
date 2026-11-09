-- Teams (NEW_DESIGN.md 9.3, 15.3): Lesetabellen des Stroms team:<id>. Das Solo-Team bleibt implizit (accounts.solo_team_id).
CREATE TABLE teams (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  member_count INTEGER NOT NULL DEFAULT 0,
  last_seq     INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE team_members (
  team_id UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  pid     UUID NOT NULL,
  since   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, pid)
);
CREATE INDEX team_members_pid ON team_members (pid);

CREATE TABLE team_invites (
  invite_id  UUID PRIMARY KEY,
  team_id    UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX team_invites_team ON team_invites (team_id);

-- Sperren gelten team-weit für alle Giveaways des Teams (NEW_DESIGN.md 15.3).
CREATE TABLE team_bans (
  team_id UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  pid     UUID NOT NULL,
  since   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, pid)
);
