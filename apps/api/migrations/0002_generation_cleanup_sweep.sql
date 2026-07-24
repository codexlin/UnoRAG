-- Durable sweep status for delayed Qdrant point deletion after delete_after.
ALTER TABLE rag.generation_cleanup_queue
	ADD COLUMN IF NOT EXISTS sweep_status varchar(32) NOT NULL DEFAULT 'pending',
	ADD COLUMN IF NOT EXISTS sweep_attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_sweep_status_check'
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_sweep_status_check
			CHECK (sweep_status IN ('pending', 'sweeping', 'deleted', 'error'));
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'generation_cleanup_sweep_attempts_check'
	) THEN
		ALTER TABLE rag.generation_cleanup_queue
			ADD CONSTRAINT generation_cleanup_sweep_attempts_check
			CHECK (sweep_attempts >= 0);
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS generation_cleanup_sweep_due_idx
	ON rag.generation_cleanup_queue (delete_after, generation_id)
	WHERE sweep_status IN ('pending', 'error');
