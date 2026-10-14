-- Topic lanes: every message in a group belongs to a topic, decided by the server.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE topics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  -- Who chose the title: derived from a message, written by a member, or (later) by the LLM.
  -- A member's title is never replaced automatically.
  title_source    text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user', 'llm')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topics_conversation_idx ON topics (conversation_id);

ALTER TABLE messages
  ADD COLUMN topic_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  -- How the topic was decided:
  --   auto  scored by the assigner         reply  followed the message it replies to
  --   lane  sent from inside a lane        user   moved there by a member (a correction)
  ADD COLUMN topic_source text CHECK (topic_source IN ('auto', 'reply', 'lane', 'user')),
  ADD COLUMN topic_score real;

-- A topic's size, last activity and unread count are all derived from its messages
-- with this index, so they can never drift from the truth after a move or a merge.
CREATE INDEX messages_topic_idx ON messages (conversation_id, topic_id, seq);

-- One vector per message with text, for every conversation (DMs too: search uses it).
-- 384 dimensions = paraphrase-multilingual-MiniLM-L12-v2.
CREATE TABLE message_embeddings (
  message_id      uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  embedding       vector(384) NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_embeddings_conversation_idx ON message_embeddings (conversation_id);

-- Every correction a member makes, kept as labelled data: what the assigner (or a
-- person) had decided, and what a person changed it to.
CREATE TABLE topic_corrections (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('move', 'merge', 'rename')),
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  from_topic_id   uuid,
  to_topic_id     uuid,
  -- For a move: the source and score the assigner had given. For a rename: old and new title.
  details         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_corrections_conversation_idx ON topic_corrections (conversation_id, created_at);
