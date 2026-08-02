DO $$
BEGIN
	IF to_regclass('app.outbox_events') IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM app.outbox_events
			WHERE status <> 'completed'
		)
	THEN
		RAISE EXCEPTION
			'cannot retire app.outbox_events while unresolved projection events remain';
	END IF;
END
$$;
--> statement-breakpoint
DROP TABLE "app"."outbox_events";
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('rag.active_document_generations') IS NOT NULL THEN
		IF EXISTS (
			SELECT 1
			FROM rag.active_document_generations AS legacy
			FULL JOIN (
				SELECT
					document.organization_id,
					document.workspace_id,
					document.id AS document_id,
					active.version_id AS document_version_id,
					version.generation_id
				FROM app.document_active_versions AS active
				JOIN app.documents AS document ON document.id = active.document_id
				JOIN app.document_versions AS version ON version.id = active.version_id
			) AS canonical
				ON canonical.document_id = legacy.document_id
			WHERE canonical.document_id IS NULL
				OR legacy.document_id IS NULL
				OR canonical.organization_id <> legacy.organization_id
				OR canonical.workspace_id <> legacy.workspace_id
				OR canonical.document_version_id <> legacy.document_version_id
				OR canonical.generation_id <> legacy.generation_id
		) THEN
			RAISE EXCEPTION
				'cannot retire rag.active_document_generations because app active pointers differ';
		END IF;
		DROP TABLE rag.active_document_generations;
	END IF;
	IF to_regclass('rag.generation_cleanup_queue') IS NOT NULL THEN
		ALTER TABLE rag.generation_cleanup_queue
			RENAME TO legacy_generation_cleanup_queue;
	END IF;
END
$$;
--> statement-breakpoint
CREATE VIEW app.active_document_generations AS
SELECT
	document.organization_id,
	document.workspace_id,
	document.library_id,
	library.rag_library_id,
	document.id AS document_id,
	active.version_id AS document_version_id,
	version.generation_id,
	active.activated_at
FROM app.document_active_versions AS active
JOIN app.documents AS document ON document.id = active.document_id
JOIN app.libraries AS library ON library.id = document.library_id
JOIN app.document_versions AS version
	ON version.id = active.version_id
	AND version.document_id = document.id;
--> statement-breakpoint
GRANT SELECT ON app.active_document_generations TO unorag_worker;
