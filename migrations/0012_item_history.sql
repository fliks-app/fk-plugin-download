ALTER TABLE "download_history" RENAME COLUMN "episodeId" TO "itemId";
UPDATE "download_history" h SET "itemId" = (
  SELECT i."id" FROM public."items" i WHERE i."mediaId" = h."mediaId" AND i."groupId" IS NULL ORDER BY i."id" LIMIT 1)
 WHERE h."itemId" IS NULL AND h."seasonId" IS NULL AND h."mediaId" IS NOT NULL;
