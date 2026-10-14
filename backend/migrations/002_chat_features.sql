-- Chat features: reactions, image uploads, group invite links.

CREATE TABLE reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- An image is uploaded first, then attached to a message by id. A message can only
-- carry an image its sender uploaded, so clients cannot inject arbitrary URLs.
CREATE TABLE uploads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        text NOT NULL,
  width      int,
  height     int,
  bytes      int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_user_idx ON uploads (user_id, created_at);

ALTER TABLE messages
  ADD COLUMN image_width  int,
  ADD COLUMN image_height int;

CREATE TABLE group_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  token           text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  uses            int NOT NULL DEFAULT 0
);
CREATE INDEX group_invites_conversation_idx ON group_invites (conversation_id);
