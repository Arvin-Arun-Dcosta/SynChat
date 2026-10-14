-- LLM-backed features: catch-up, decided-or-open, and the questions inbox.
-- All three come from one "topic digest" produced by an outside AI provider, so they
-- are off until a group's admin turns them on for that group.

ALTER TABLE conversations
  ADD COLUMN ai_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_enabled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN ai_enabled_at timestamptz;

ALTER TABLE topics
  -- A two-line summary of the topic's most recent stretch (catch-up).
  ADD COLUMN recap text,
  ADD COLUMN status text CHECK (status IN ('open', 'decided')),
  ADD COLUMN outcome text,
  -- 'user' means a member set the status by hand; the digest never overwrites that.
  ADD COLUMN status_source text CHECK (status_source IN ('llm', 'user')),
  -- The newest message the digest has seen. Older than the topic's last message = stale.
  ADD COLUMN digest_through_seq bigint,
  ADD COLUMN digest_at timestamptz,
  ADD COLUMN digest_model text;

-- Questions the digest found that were put to a particular member.
CREATE TABLE topic_questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topic_id        uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asked_of        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        text NOT NULL,
  answered        boolean NOT NULL DEFAULT false,
  dismissed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, asked_of)
);
-- The inbox: what is still waiting on one person.
CREATE INDEX topic_questions_inbox_idx ON topic_questions (asked_of) WHERE NOT answered AND dismissed_at IS NULL;

-- A member overriding a topic's status is a correction too.
ALTER TABLE topic_corrections DROP CONSTRAINT topic_corrections_kind_check;
ALTER TABLE topic_corrections ADD CONSTRAINT topic_corrections_kind_check CHECK (kind IN ('move', 'merge', 'rename', 'status'));
