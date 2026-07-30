\set ON_ERROR_STOP on

\getenv web_password UNORAG_WEB_DB_PASSWORD
\getenv api_password UNORAG_API_DB_PASSWORD
\getenv worker_password UNORAG_WORKER_DB_PASSWORD
\getenv outbox_password UNORAG_OUTBOX_DB_PASSWORD
\getenv rag_read_password UNORAG_RAG_READ_DB_PASSWORD
\getenv dbos_password UNORAG_DBOS_DB_PASSWORD
\getenv dbos_database UNORAG_DBOS_DATABASE

SELECT :'dbos_database' = current_database() AS dbos_database_conflicts \gset
\if :dbos_database_conflicts
	DO $$
	BEGIN
		RAISE EXCEPTION
			'UNORAG_DBOS_DATABASE must be separate from the UnoRAG application database';
	END $$;
\endif

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web_login') THEN
		CREATE ROLE unorag_web_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_api_login') THEN
		CREATE ROLE unorag_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker_login') THEN
		CREATE ROLE unorag_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_outbox_login') THEN
		CREATE ROLE unorag_outbox_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_rag_read_login') THEN
		CREATE ROLE unorag_rag_read_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_dbos_login') THEN
		CREATE ROLE unorag_dbos_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
END $$;

ALTER ROLE unorag_web_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_api_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_worker_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_outbox_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_rag_read_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_dbos_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;

SELECT format('ALTER ROLE unorag_web_login PASSWORD %L', :'web_password') \gexec
SELECT format('ALTER ROLE unorag_api_login PASSWORD %L', :'api_password') \gexec
SELECT format('ALTER ROLE unorag_worker_login PASSWORD %L', :'worker_password') \gexec
SELECT format('ALTER ROLE unorag_outbox_login PASSWORD %L', :'outbox_password') \gexec
SELECT format('ALTER ROLE unorag_rag_read_login PASSWORD %L', :'rag_read_password') \gexec
SELECT format('ALTER ROLE unorag_dbos_login PASSWORD %L', :'dbos_password') \gexec

SELECT format(
	'CREATE DATABASE %I OWNER unorag_dbos_login',
	:'dbos_database'
)
WHERE NOT EXISTS (
	SELECT 1 FROM pg_database WHERE datname = :'dbos_database'
)
\gexec
SELECT format(
	'ALTER DATABASE %I OWNER TO unorag_dbos_login',
	:'dbos_database'
)
\gexec

DO $$
DECLARE
	membership record;
BEGIN
	FOR membership IN
		SELECT granted.rolname AS granted_role, member.rolname AS member_role
		FROM pg_auth_members AS auth
		JOIN pg_roles AS granted ON granted.oid = auth.roleid
		JOIN pg_roles AS member ON member.oid = auth.member
		WHERE granted.rolname IN (
			'unorag_web',
			'unorag_api',
			'unorag_worker',
			'unorag_outbox',
			'unorag_rag_read'
		)
		  AND member.rolname IN (
			'unorag_web_login',
			'unorag_api_login',
			'unorag_worker_login',
			'unorag_outbox_login',
			'unorag_rag_read_login'
		  )
	LOOP
		EXECUTE format(
			'REVOKE %I FROM %I',
			membership.granted_role,
			membership.member_role
		);
	END LOOP;
END $$;

GRANT unorag_web TO unorag_web_login;
GRANT unorag_api TO unorag_api_login;
GRANT unorag_worker TO unorag_worker_login;
GRANT unorag_outbox TO unorag_outbox_login;
GRANT unorag_rag_read TO unorag_rag_read_login;

-- PostgreSQL grants CONNECT to PUBLIC by default. Replace that broad grant
-- with the explicit application login set so the DBOS system login cannot
-- even establish a session against the business database.
SELECT format(
	'REVOKE CONNECT ON DATABASE %I FROM PUBLIC',
	current_database()
) \gexec
SELECT format(
	'GRANT CONNECT ON DATABASE %I TO unorag_web_login, unorag_api_login, unorag_worker_login, unorag_outbox_login, unorag_rag_read_login',
	current_database()
) \gexec

-- DBOS owns only its dedicated system database. It receives no UnoRAG runtime
-- role and therefore no app/rag/public table privileges.
REVOKE ALL PRIVILEGES ON SCHEMA app, rag, public FROM unorag_dbos_login;
