\set ON_ERROR_STOP on

\getenv web_password UNORAG_WEB_DB_PASSWORD
\getenv worker_password UNORAG_WORKER_DB_PASSWORD
\getenv dbos_password UNORAG_DBOS_DB_PASSWORD
\getenv dbos_database UNORAG_DBOS_DATABASE

SELECT :'dbos_database' = current_database() AS dbos_database_conflicts \gset
\if :dbos_database_conflicts
	DO $$ BEGIN RAISE EXCEPTION 'DBOS database must be separate from the application database'; END $$;
\endif

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web_login') THEN
		CREATE ROLE unorag_web_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker_login') THEN
		CREATE ROLE unorag_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_dbos_login') THEN
		CREATE ROLE unorag_dbos_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
	END IF;
END $$;

ALTER ROLE unorag_web_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_worker_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE unorag_dbos_login NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
SELECT format('ALTER ROLE unorag_web_login PASSWORD %L', :'web_password') \gexec
SELECT format('ALTER ROLE unorag_worker_login PASSWORD %L', :'worker_password') \gexec
SELECT format('ALTER ROLE unorag_dbos_login PASSWORD %L', :'dbos_password') \gexec

GRANT unorag_web TO unorag_web_login;
GRANT unorag_worker TO unorag_worker_login;

SELECT format('CREATE DATABASE %I OWNER unorag_dbos_login', :'dbos_database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbos_database') \gexec
SELECT format('ALTER DATABASE %I OWNER TO unorag_dbos_login', :'dbos_database') \gexec

SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format(
	'GRANT CONNECT ON DATABASE %I TO unorag_web_login, unorag_worker_login',
	current_database()
) \gexec
REVOKE ALL PRIVILEGES ON SCHEMA app, public FROM unorag_dbos_login;
