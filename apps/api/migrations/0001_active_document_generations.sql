CREATE SCHEMA IF NOT EXISTS rag;

CREATE TABLE IF NOT EXISTS rag.active_document_generations (
	organization_id uuid NOT NULL
		REFERENCES app.organizations(id) ON DELETE CASCADE,
	workspace_id uuid NOT NULL
		REFERENCES app.workspaces(id) ON DELETE CASCADE,
	library_id uuid NOT NULL
		REFERENCES app.libraries(id) ON DELETE CASCADE,
	rag_library_id varchar(128) NOT NULL,
	document_id uuid NOT NULL
		REFERENCES app.documents(id) ON DELETE CASCADE,
	document_version_id uuid NOT NULL,
	generation_id uuid NOT NULL,
	activated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, workspace_id, document_id),
	CONSTRAINT active_document_generations_same_document_fk
		FOREIGN KEY (document_id, document_version_id)
		REFERENCES app.document_versions(document_id, id)
		ON DELETE CASCADE,
	CONSTRAINT active_document_generations_version_uq
		UNIQUE (document_version_id),
	CONSTRAINT active_document_generations_generation_uq
		UNIQUE (generation_id)
);

CREATE INDEX IF NOT EXISTS active_document_generations_library_idx
	ON rag.active_document_generations (
		organization_id,
		workspace_id,
		rag_library_id,
		generation_id
	);

CREATE TABLE IF NOT EXISTS rag.generation_cleanup_queue (
	generation_id uuid PRIMARY KEY,
	organization_id uuid NOT NULL
		REFERENCES app.organizations(id) ON DELETE CASCADE,
	workspace_id uuid NOT NULL
		REFERENCES app.workspaces(id) ON DELETE CASCADE,
	library_id uuid NOT NULL
		REFERENCES app.libraries(id) ON DELETE CASCADE,
	document_id uuid NOT NULL
		REFERENCES app.documents(id) ON DELETE CASCADE,
	document_version_id uuid NOT NULL
		REFERENCES app.document_versions(id) ON DELETE CASCADE,
	delete_after timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
	hint_status varchar(32) NOT NULL DEFAULT 'pending',
	hint_attempts integer NOT NULL DEFAULT 0,
	last_error text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT generation_cleanup_hint_status_check
		CHECK (hint_status IN ('pending', 'applied', 'error')),
	CONSTRAINT generation_cleanup_attempts_check
		CHECK (hint_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS generation_cleanup_due_idx
	ON rag.generation_cleanup_queue (delete_after, generation_id);

-- Upgrade L2 jobs which were intentionally parked before activation existed.
UPDATE app.jobs AS job
SET status = 'retry',
	next_attempt_at = now(),
	finished_at = NULL,
	updated_at = now()
FROM app.document_versions AS version
WHERE version.id = job.document_version_id
  AND job.type = 'document.ingest'
  AND job.status = 'completed'
  AND job.stage = 'awaiting_activation'
  AND version.status = 'indexed';
