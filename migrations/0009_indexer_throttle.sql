CREATE TABLE IF NOT EXISTS "indexer_throttle" (
  "indexerId"            integer PRIMARY KEY REFERENCES "indexers"("id") ON DELETE CASCADE,
  "busyToken"            text,
  "busyUntil"            timestamptz,
  "nextAllowedAt"        timestamptz,
  "failureCount"         integer NOT NULL DEFAULT 0,
  "cooldownUntil"        timestamptz,
  "cooldownReason"       text,
  "cooldownFailureCount" integer,
  "cooldownDetail"       text,
  "updatedAt"            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO "indexer_throttle" ("indexerId") SELECT "id" FROM "indexers" ON CONFLICT DO NOTHING;
