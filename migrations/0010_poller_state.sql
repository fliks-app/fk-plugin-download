CREATE TABLE IF NOT EXISTS "poller_state" (
  "key"       text PRIMARY KEY,
  "value"     jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
