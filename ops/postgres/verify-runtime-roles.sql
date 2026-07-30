\set ON_ERROR_STOP on
\getenv dbos_database UNORAG_DBOS_DATABASE

DO $$
BEGIN
	IF NOT has_table_privilege(
		'unorag_web_login',
		'app.users',
		'SELECT,INSERT,UPDATE,DELETE'
	) OR has_table_privilege('unorag_web_login', 'public.turns', 'SELECT') THEN
		RAISE EXCEPTION 'unorag_web_login privilege boundary is invalid';
	END IF;

	IF NOT has_table_privilege(
		'unorag_api_login',
		'public.turns',
		'SELECT,INSERT,UPDATE,DELETE'
	) OR has_table_privilege('unorag_api_login', 'app.users', 'SELECT') THEN
		RAISE EXCEPTION 'unorag_api_login privilege boundary is invalid';
	END IF;

	IF NOT has_table_privilege(
		'unorag_worker_login',
		'app.jobs',
		'SELECT,UPDATE'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.jobs',
		'payload',
		'UPDATE'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.jobs',
		'workflow_id',
		'UPDATE'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.jobs',
		'execution_engine',
		'INSERT'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.documents',
		'acl_fingerprint',
		'UPDATE'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.documents',
		'projected_acl_fingerprint',
		'UPDATE'
	) OR NOT has_table_privilege(
		'unorag_worker_login',
		'app.outbox_events',
		'INSERT'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'app.outbox_events',
		'idempotency_key',
		'SELECT'
	) OR has_table_privilege(
		'unorag_worker_login',
		'app.outbox_events',
		'SELECT'
	) OR NOT has_table_privilege(
		'unorag_worker_login',
		'public.documents',
		'SELECT,DELETE'
	) OR NOT has_table_privilege(
		'unorag_worker_login',
		'public.libraries',
		'SELECT'
	) OR NOT has_column_privilege(
		'unorag_worker_login',
		'public.libraries',
		'doc_count',
		'UPDATE'
	) OR has_table_privilege(
		'unorag_worker_login',
		'public.libraries',
		'DELETE'
	) OR has_table_privilege(
		'unorag_worker_login',
		'public.threads',
		'SELECT'
	) OR has_table_privilege(
		'unorag_worker_login',
		'public.turns',
		'SELECT'
	) OR has_table_privilege(
		'unorag_worker_login',
		'app.organizations',
		'UPDATE'
	) THEN
		RAISE EXCEPTION 'unorag_worker_login privilege boundary is invalid';
	END IF;

	IF NOT has_table_privilege(
		'unorag_outbox_login',
		'app.outbox_events',
		'SELECT,UPDATE'
	) OR NOT has_schema_privilege(
		'unorag_outbox_login',
		'app',
		'USAGE'
	) OR has_table_privilege(
		'unorag_outbox_login',
		'app.outbox_events',
		'INSERT'
	) OR has_table_privilege(
		'unorag_outbox_login',
		'app.users',
		'SELECT'
	) THEN
		RAISE EXCEPTION 'unorag_outbox_login privilege boundary is invalid';
	END IF;

	IF NOT has_table_privilege(
		'unorag_rag_read_login',
		'rag.active_document_generations',
		'SELECT'
	) OR NOT has_column_privilege(
		'unorag_rag_read_login',
		'app.documents',
		'acl_fingerprint',
		'SELECT'
	) OR has_column_privilege(
		'unorag_rag_read_login',
		'app.documents',
		'filename',
		'SELECT'
	) OR has_table_privilege(
		'unorag_rag_read_login',
		'rag.active_document_generations',
		'UPDATE'
	) THEN
		RAISE EXCEPTION 'unorag_rag_read_login privilege boundary is invalid';
	END IF;

	IF has_schema_privilege('unorag_dbos_login', 'app', 'USAGE')
		OR has_schema_privilege('unorag_dbos_login', 'rag', 'USAGE')
		OR has_database_privilege(
			'unorag_dbos_login',
			current_database(),
			'CONNECT'
		)
		OR has_table_privilege('unorag_dbos_login', 'app.jobs', 'SELECT')
		OR has_table_privilege(
			'unorag_dbos_login',
			'rag.generation_cleanup_queue',
			'SELECT'
		) THEN
		RAISE EXCEPTION 'unorag_dbos_login can access application data';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM pg_roles
		WHERE rolname IN (
			'unorag_web_login',
			'unorag_api_login',
			'unorag_worker_login',
			'unorag_outbox_login',
			'unorag_rag_read_login',
			'unorag_dbos_login'
		)
		  AND (rolsuper OR rolcreatedb OR rolcreaterole)
	) THEN
		RAISE EXCEPTION 'a runtime login has administrative attributes';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM pg_roles
		WHERE rolname IN (
			'unorag_web_login',
			'unorag_api_login',
			'unorag_worker_login',
			'unorag_outbox_login',
			'unorag_rag_read_login'
		)
		  AND (
			has_schema_privilege(rolname, 'app', 'CREATE')
			OR has_schema_privilege(rolname, 'rag', 'CREATE')
			OR has_schema_privilege(rolname, 'public', 'CREATE')
		  )
	) THEN
		RAISE EXCEPTION 'a runtime login has schema CREATE privilege';
	END IF;

	IF EXISTS (
		WITH expected(member_role, granted_role) AS (
			VALUES
				('unorag_web_login', 'unorag_web'),
				('unorag_api_login', 'unorag_api'),
				('unorag_worker_login', 'unorag_worker'),
				('unorag_outbox_login', 'unorag_outbox'),
				('unorag_rag_read_login', 'unorag_rag_read')
		),
		actual AS (
			SELECT
				member.rolname AS member_role,
				granted.rolname AS granted_role
			FROM pg_auth_members AS auth
			JOIN pg_roles AS granted ON granted.oid = auth.roleid
			JOIN pg_roles AS member ON member.oid = auth.member
			WHERE member.rolname LIKE 'unorag\_%\_login' ESCAPE '\'
			  AND granted.rolname IN (
				'unorag_web',
				'unorag_api',
				'unorag_worker',
				'unorag_outbox',
				'unorag_rag_read'
			  )
		)
		(SELECT * FROM expected EXCEPT SELECT * FROM actual)
		UNION ALL
		(SELECT * FROM actual EXCEPT SELECT * FROM expected)
	) THEN
		RAISE EXCEPTION 'runtime login membership set is invalid';
	END IF;

END $$;

SELECT EXISTS (
	SELECT 1
	FROM pg_database AS database
	JOIN pg_roles AS owner ON owner.oid = database.datdba
	WHERE database.datname = :'dbos_database'
	  AND owner.rolname = 'unorag_dbos_login'
) AS dbos_database_owner_valid
\gset
\if :dbos_database_owner_valid
\else
	DO $$
	BEGIN
		RAISE EXCEPTION 'DBOS system database is missing or has the wrong owner';
	END $$;
\endif

SELECT has_database_privilege(
	'unorag_dbos_login',
	:'dbos_database',
	'CONNECT'
) AS dbos_database_connect_valid
\gset
\if :dbos_database_connect_valid
\else
	DO $$
	BEGIN
		RAISE EXCEPTION 'DBOS login cannot connect to its system database';
	END $$;
\endif

SELECT 'runtime role verification passed' AS result;
