-- Runtime metadata tables are migrated here so the FastAPI login never needs DDL.
CREATE TABLE IF NOT EXISTS public.libraries (
	id varchar(128) PRIMARY KEY,
	tenant_id varchar(128) NOT NULL,
	workspace_id varchar(128) NOT NULL,
	name varchar(256) NOT NULL,
	description text,
	status varchar(32) NOT NULL,
	doc_count integer NOT NULL,
	ready_count integer NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.documents (
	id varchar(128) PRIMARY KEY,
	library_id varchar(128) NOT NULL,
	tenant_id varchar(128) NOT NULL,
	workspace_id varchar(128) NOT NULL,
	name varchar(512) NOT NULL,
	filename varchar(512) NOT NULL,
	content_type varchar(128) NOT NULL,
	status varchar(32) NOT NULL,
	chunk_count integer NOT NULL,
	size_bytes integer,
	error text,
	parser_report text,
	storage_key varchar(512),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.threads (
	id varchar(128) PRIMARY KEY,
	session_id varchar(128),
	library_id varchar(128),
	title varchar(256) NOT NULL,
	status varchar(32) NOT NULL,
	tenant_id varchar(128) NOT NULL,
	workspace_id varchar(128) NOT NULL,
	principal_id varchar(128) NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.turns (
	id varchar(128) PRIMARY KEY,
	session_id varchar(128) NOT NULL,
	thread_id varchar(128),
	library_id varchar(128),
	question text NOT NULL,
	answer text NOT NULL,
	citations_json text NOT NULL,
	mode varchar(32) NOT NULL,
	refused integer NOT NULL,
	refuse_reason varchar(64),
	query_type varchar(64),
	rewrite varchar(64),
	rewritten_query text,
	judge_json text,
	retrieval_plan_json text,
	retrieval_debug_json text,
	document_version_id varchar(256),
	tenant_id varchar(128),
	workspace_id varchar(128),
	principal_id varchar(128),
	created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.libraries
	ADD COLUMN IF NOT EXISTS tenant_id varchar(128),
	ADD COLUMN IF NOT EXISTS workspace_id varchar(128),
	ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.documents
	ADD COLUMN IF NOT EXISTS tenant_id varchar(128),
	ADD COLUMN IF NOT EXISTS workspace_id varchar(128),
	ADD COLUMN IF NOT EXISTS size_bytes integer,
	ADD COLUMN IF NOT EXISTS parser_report text,
	ADD COLUMN IF NOT EXISTS storage_key varchar(512);

ALTER TABLE public.turns
	ADD COLUMN IF NOT EXISTS thread_id varchar(128),
	ADD COLUMN IF NOT EXISTS query_type varchar(64),
	ADD COLUMN IF NOT EXISTS rewrite varchar(64),
	ADD COLUMN IF NOT EXISTS rewritten_query text,
	ADD COLUMN IF NOT EXISTS judge_json text,
	ADD COLUMN IF NOT EXISTS retrieval_plan_json text,
	ADD COLUMN IF NOT EXISTS retrieval_debug_json text,
	ADD COLUMN IF NOT EXISTS document_version_id varchar(256),
	ADD COLUMN IF NOT EXISTS tenant_id varchar(128),
	ADD COLUMN IF NOT EXISTS workspace_id varchar(128),
	ADD COLUMN IF NOT EXISTS principal_id varchar(128);

UPDATE public.libraries AS public_library
SET tenant_id = control_library.organization_id::text,
	workspace_id = control_library.workspace_id::text
FROM app.libraries AS control_library
WHERE control_library.rag_library_id = public_library.id
  AND (
	public_library.tenant_id IS NULL
	OR public_library.workspace_id IS NULL
  );

UPDATE public.documents AS public_document
SET tenant_id = control_document.organization_id::text,
	workspace_id = control_document.workspace_id::text
FROM app.documents AS control_document
JOIN app.libraries AS control_library
	ON control_library.id = control_document.library_id
WHERE control_document.rag_document_id = public_document.id
  AND control_library.rag_library_id = public_document.library_id
  AND (
	public_document.tenant_id IS NULL
	OR public_document.workspace_id IS NULL
  );

CREATE INDEX IF NOT EXISTS ix_libraries_tenant_id
	ON public.libraries (tenant_id);
CREATE INDEX IF NOT EXISTS ix_libraries_workspace_id
	ON public.libraries (workspace_id);
CREATE INDEX IF NOT EXISTS ix_libraries_scope
	ON public.libraries (tenant_id, workspace_id);

CREATE INDEX IF NOT EXISTS ix_documents_library_id
	ON public.documents (library_id);
CREATE INDEX IF NOT EXISTS ix_documents_tenant_id
	ON public.documents (tenant_id);
CREATE INDEX IF NOT EXISTS ix_documents_workspace_id
	ON public.documents (workspace_id);
CREATE INDEX IF NOT EXISTS ix_documents_scope
	ON public.documents (tenant_id, workspace_id);

CREATE INDEX IF NOT EXISTS ix_threads_session_id
	ON public.threads (session_id);
CREATE INDEX IF NOT EXISTS ix_threads_library_id
	ON public.threads (library_id);
CREATE INDEX IF NOT EXISTS ix_threads_tenant_id
	ON public.threads (tenant_id);
CREATE INDEX IF NOT EXISTS ix_threads_workspace_id
	ON public.threads (workspace_id);
CREATE INDEX IF NOT EXISTS ix_threads_principal_id
	ON public.threads (principal_id);
CREATE INDEX IF NOT EXISTS ix_threads_scope
	ON public.threads (tenant_id, workspace_id, principal_id);

CREATE INDEX IF NOT EXISTS ix_turns_session_id
	ON public.turns (session_id);
CREATE INDEX IF NOT EXISTS ix_turns_library_id
	ON public.turns (library_id);
CREATE INDEX IF NOT EXISTS ix_turns_thread_id
	ON public.turns (thread_id);
