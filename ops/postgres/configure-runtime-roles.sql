\set ON_ERROR_STOP on

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_migrator') THEN
		CREATE ROLE unorag_migrator NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		CREATE ROLE unorag_web NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		CREATE ROLE unorag_worker NOLOGIN;
	END IF;
END $$;

REVOKE ALL PRIVILEGES ON SCHEMA app, public FROM unorag_web, unorag_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA app, public FROM unorag_web, unorag_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app, public FROM unorag_web, unorag_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO unorag_web, unorag_worker;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO unorag_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app TO unorag_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO unorag_web;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO unorag_web;

GRANT SELECT ON
	app.organizations,
	app.workspaces,
	app.jobs,
	app.documents,
	app.document_versions,
	app.document_active_versions,
	app.active_document_generations,
	app.document_acl,
	app.libraries,
	app.generation_cleanup_queue
TO unorag_worker;
GRANT INSERT, UPDATE ON app.jobs TO unorag_worker;
GRANT UPDATE ON app.document_versions, app.documents, app.libraries TO unorag_worker;
GRANT INSERT, UPDATE, DELETE ON app.document_active_versions TO unorag_worker;
GRANT INSERT, UPDATE, DELETE ON app.generation_cleanup_queue TO unorag_worker;
GRANT INSERT ON app.audit_logs TO unorag_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO unorag_worker;
