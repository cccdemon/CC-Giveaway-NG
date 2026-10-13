CREATE TABLE stream_heads (
  stream   TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE SEQUENCE events_id_seq AS BIGINT;

CREATE TABLE events (
  id                BIGINT NOT NULL DEFAULT nextval('events_id_seq'),
  stream            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  type_version      INTEGER NOT NULL,
  payload           JSONB NOT NULL,
  actor             TEXT NOT NULL,
  reason            TEXT,
  reverses_event_id BIGINT,
  correlation_id    UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

ALTER SEQUENCE events_id_seq OWNED BY events.id;

CREATE INDEX events_stream_seq ON events (stream, seq);
CREATE INDEX events_reverses ON events (reverses_event_id) WHERE reverses_event_id IS NOT NULL;
CREATE INDEX events_id ON events (id);

CREATE TABLE snapshots (
  stream          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  reducer         TEXT NOT NULL,
  reducer_version INTEGER NOT NULL,
  state           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (stream, reducer, reducer_version, seq)
);

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events ist append-only. Schreibe ein Gegen-Ereignis statt zu ändern oder zu löschen.';
END
$$;

CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
