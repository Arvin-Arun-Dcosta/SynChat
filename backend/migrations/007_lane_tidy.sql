-- Lane tidy-up: in groups with AI features on, the LLM re-sorts recent messages when
-- the conversation goes quiet, correcting the first-pass assigner.

-- How far the tidy-up has looked. Nothing newer than this = nothing to do.
ALTER TABLE conversations ADD COLUMN tidy_through_seq bigint;

-- 'llm': moved by the tidy-up. Messages a person placed ('user', 'lane') are never moved by it.
ALTER TABLE messages DROP CONSTRAINT messages_topic_source_check;
ALTER TABLE messages ADD CONSTRAINT messages_topic_source_check CHECK (topic_source IN ('auto', 'reply', 'lane', 'user', 'llm'));
