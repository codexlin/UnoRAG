-- Explicit row ownership prevents the Python sweeper and DBOS from consuming
-- the same cleanup operation during a controlled runtime migration.
SET LOCAL lock_timeout = '5s';

ALTER TABLE rag.generation_cleanup_queue
	ADD COLUMN IF NOT EXISTS execution_engine varchar(16),
	ADD COLUMN IF NOT EXISTS cleanup_job_id uuid,
	ADD COLUMN IF NOT EXISTS sweep_last_error text,
	ADD COLUMN IF NOT EXISTS sweep_updated_at timestamptz;

UPDATE rag.generation_cleanup_queue
SET execution_engine = coalesce(execution_engine, 'python'),
	sweep_updated_at = coalesce(sweep_updated_at, updated_at, now())
WHERE execution_engine IS NULL
   OR sweep_updated_at IS NULL;

ALTER TABLE rag.generation_cleanup_queue
	ALTER COLUMN execution_engine SET DEFAULT 'python',
	ALTER COLUMN execution_engine SET NOT NULL,
	ALTER COLUMN sweep_updated_at SET DEFAULT now(),
	ALTER COLUMN sweep_updated_at SET NOT NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_execution_engine_check'
		  AND conrelid = 'rag.generation_cleanup_queue'::regclass
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_execution_engine_check
			CHECK (execution_engine IN ('python', 'dbos'))
			NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_job_fk'
		  AND conrelid = 'rag.generation_cleanup_queue'::regclass
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_job_fk
			FOREIGN KEY (cleanup_job_id)
			REFERENCES app.jobs(id)
			ON DELETE SET NULL
			NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_ownership_check'
		  AND conrelid = 'rag.generation_cleanup_queue'::regclass
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_ownership_check
			CHECK (
				(execution_engine = 'python' AND cleanup_job_id IS NULL)
				OR execution_engine = 'dbos'
			)
			NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_sweeping_owner_check'
		  AND conrelid = 'rag.generation_cleanup_queue'::regclass
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_sweeping_owner_check
			CHECK (
				execution_engine <> 'dbos'
				OR sweep_status <> 'sweeping'
				OR cleanup_job_id IS NOT NULL
			)
			NOT VALID;
	END IF;
END $$;

ALTER TABLE rag.generation_cleanup_queue
	VALIDATE CONSTRAINT generation_cleanup_execution_engine_check;
ALTER TABLE rag.generation_cleanup_queue
	VALIDATE CONSTRAINT generation_cleanup_job_fk;
ALTER TABLE rag.generation_cleanup_queue
	VALIDATE CONSTRAINT generation_cleanup_ownership_check;
ALTER TABLE rag.generation_cleanup_queue
	VALIDATE CONSTRAINT generation_cleanup_sweeping_owner_check;

CREATE UNIQUE INDEX IF NOT EXISTS generation_cleanup_job_uq
	ON rag.generation_cleanup_queue (cleanup_job_id)
	WHERE cleanup_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS generation_cleanup_engine_due_idx
	ON rag.generation_cleanup_queue (
		execution_engine,
		delete_after,
		generation_id
	)
	WHERE sweep_status IN ('pending', 'error', 'sweeping');
