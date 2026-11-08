-- Stop lifecycle writers and drain ingest jobs before upgrading their source contract.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.jobs
    WHERE type = 'document.ingest'
      AND status IN ('queued', 'retry', 'running', 'cancelling')
  ) THEN
    RAISE EXCEPTION 'Drain document.ingest jobs before migrating version source metadata';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "source_filename" varchar(512);
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "source_content_type" varchar(128);
--> statement-breakpoint
-- Only the upload owning this immutable object can attest to its source metadata.
-- Historical reindex payloads may already contain metadata from a later replacement.
-- Do not infer original names from lossy storage basenames or mutable documents.
WITH sources AS (
  SELECT v.document_id, v.storage_key, v.content_hash,
    min(j.payload->>'filename') AS filename,
    min(j.payload->>'content_type') AS content_type
  FROM app.document_versions v
  JOIN app.documents d ON d.id = v.document_id
  JOIN app.jobs j ON j.document_version_id = v.id
    AND j.organization_id = d.organization_id AND j.workspace_id = d.workspace_id
    AND j.type = 'document.ingest'
  WHERE starts_with(v.storage_key,
    'org/' || d.organization_id || '/workspace/' || d.workspace_id ||
    '/library/' || d.library_id || '/document/' || d.id || '/version/' || v.id || '/source/')
    AND j.payload->>'document_id' = v.document_id::text
    AND j.payload->>'document_version_id' = v.id::text
    AND j.payload->>'generation_id' = v.generation_id::text
    AND j.payload->>'storage_key' = v.storage_key
    AND j.payload->>'content_hash' = v.content_hash
  GROUP BY v.document_id, v.storage_key, v.content_hash
  HAVING count(DISTINCT jsonb_build_array(j.payload->'filename', j.payload->'content_type')) = 1
    AND bool_and(jsonb_typeof(j.payload->'filename') = 'string'
      AND jsonb_typeof(j.payload->'content_type') = 'string'
      AND length(btrim(j.payload->>'filename')) BETWEEN 1 AND 512
      AND length(btrim(j.payload->>'content_type')) BETWEEN 1 AND 128)
)
UPDATE app.document_versions v
SET source_filename = s.filename, source_content_type = s.content_type
FROM sources s
WHERE v.document_id = s.document_id
  AND v.storage_key = s.storage_key AND v.content_hash = s.content_hash;
