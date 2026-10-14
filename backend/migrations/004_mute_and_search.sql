-- Topic mute, @mentions, per-user feature switches, and search indexes.

-- Which smart features a person has switched off for themselves. A missing key means on.
ALTER TABLE users ADD COLUMN smart jsonb NOT NULL DEFAULT '{}';

-- Muting is personal: it changes what one member is notified about, nothing else.
CREATE TABLE topic_mutes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- Who a message @mentions. A mention gets through a muted topic.
CREATE TABLE message_mentions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id);

-- Keyword search. The 'simple' configuration does no stemming and has no stop
-- words, which is what mixed-language chat needs: Hindi written in Latin letters
-- would be mangled by an English stemmer.
ALTER TABLE messages ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;
CREATE INDEX messages_tsv_idx ON messages USING gin (tsv);

-- Meaning search: approximate nearest neighbours by cosine distance.
CREATE INDEX message_embeddings_hnsw_idx ON message_embeddings USING hnsw (embedding vector_cosine_ops);
