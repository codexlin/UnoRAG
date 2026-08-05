import type { Pool, PoolClient } from "pg";

export interface TombstoneBatchInput {
	before: Date;
	limit: number;
}

export interface TombstoneMaintenanceRepository {
	countExpiredDocuments(input: TombstoneBatchInput): Promise<number>;
	purgeExpiredDocuments(input: TombstoneBatchInput): Promise<number>;
	countPurgeableLibraries(input: TombstoneBatchInput): Promise<number>;
	countBlockedLibraries(input: TombstoneBatchInput): Promise<number>;
	purgeExpiredLibraries(input: TombstoneBatchInput): Promise<number>;
}

function validateInput(input: TombstoneBatchInput): void {
	if (Number.isNaN(input.before.getTime())) {
		throw new Error("before must be a valid date");
	}
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit <= 0 ||
		input.limit > 10_000
	) {
		throw new Error("limit must be an integer between 1 and 10000");
	}
}

const DOCUMENT_ELIGIBILITY = `
	document.status = 'deleted'
	AND document.deleted_at < $1
	AND NOT EXISTS (
		SELECT 1
		FROM app.generation_cleanup_queue AS cleanup
		WHERE cleanup.document_id = document.id
		  AND cleanup.sweep_status <> 'deleted'
	)
`;

function libraryEligibility(beforeParameter = "$1"): string {
	return `
	library.status = 'deleted'
	AND library.updated_at < ${beforeParameter}
	AND NOT EXISTS (
		SELECT 1 FROM app.documents AS document
		WHERE document.library_id = library.id
	)
	AND NOT EXISTS (
		SELECT 1 FROM app.threads AS thread
		WHERE thread.organization_id = library.organization_id
		  AND thread.workspace_id = library.workspace_id
		  AND thread.rag_library_id = library.rag_library_id
	)
	AND NOT EXISTS (
		SELECT 1 FROM app.ask_runs AS ask_run
		WHERE ask_run.library_id = library.id
	)`;
}

export class PostgresTombstoneMaintenanceRepository
	implements TombstoneMaintenanceRepository
{
	constructor(private readonly pool: Pool) {}

	async countExpiredDocuments(input: TombstoneBatchInput): Promise<number> {
		validateInput(input);
		const result = await this.pool.query<{ count: number }>(
			`SELECT count(*)::integer AS count
			 FROM (
				 SELECT document.id
				 FROM app.documents AS document
				 WHERE ${DOCUMENT_ELIGIBILITY}
				 ORDER BY document.deleted_at, document.id
				 LIMIT $2
			 ) AS candidates`,
			[input.before, input.limit],
		);
		return Number(result.rows[0]?.count ?? 0);
	}

	async purgeExpiredDocuments(input: TombstoneBatchInput): Promise<number> {
		validateInput(input);
		return this.transaction(async (client) => {
			const candidates = await client.query<{
				id: string;
				organization_id: string;
				workspace_id: string;
				deleted_at: Date;
			}>(
				`SELECT document.id, document.organization_id,
				        document.workspace_id, document.deleted_at
				 FROM app.documents AS document
				 WHERE ${DOCUMENT_ELIGIBILITY}
				 ORDER BY document.deleted_at, document.id
				 LIMIT $2
				 FOR UPDATE OF document SKIP LOCKED`,
				[input.before, input.limit],
			);
			const ids = candidates.rows.map((row) => row.id);
			if (ids.length === 0) return 0;
			await client.query(
				`SELECT generation_id
				 FROM app.generation_cleanup_queue
				 WHERE document_id = ANY($1::uuid[])
				 FOR UPDATE`,
				[ids],
			);

			await client.query(
				`INSERT INTO app.audit_logs (
					organization_id, workspace_id, action, resource_type,
					resource_id, details
				)
				SELECT document.organization_id, document.workspace_id,
				       'document.tombstone_purged', 'document', document.id::text,
				       jsonb_build_object(
						'deleted_at', document.deleted_at,
						'retention_before', $2::timestamptz
					 )
				FROM app.documents AS document
				WHERE document.id = ANY($1::uuid[])`,
				[ids, input.before],
			);
			await client.query(
				`UPDATE app.documents
				 SET desired_version_id = NULL, latest_job_id = NULL
				 WHERE id = ANY($1::uuid[])`,
				[ids],
			);
			await client.query(
				"DELETE FROM app.document_active_versions WHERE document_id = ANY($1::uuid[])",
				[ids],
			);
			const deleted = await client.query<{ id: string }>(
				`DELETE FROM app.documents
				 WHERE id = ANY($1::uuid[])
				   AND status = 'deleted'
				   AND deleted_at < $2
				   AND NOT EXISTS (
					 SELECT 1
					 FROM app.generation_cleanup_queue AS cleanup
					 WHERE cleanup.document_id = app.documents.id
					   AND cleanup.sweep_status <> 'deleted'
				   )
				 RETURNING id`,
				[ids, input.before],
			);
			return deleted.rowCount ?? 0;
		});
	}

	async countPurgeableLibraries(input: TombstoneBatchInput): Promise<number> {
		validateInput(input);
		return this.countLibraries(input, libraryEligibility());
	}

	async countBlockedLibraries(input: TombstoneBatchInput): Promise<number> {
		validateInput(input);
		return this.countLibraries(
			input,
			`library.status = 'deleted'
			 AND library.updated_at < $1
			 AND NOT (${libraryEligibility()})`,
		);
	}

	async purgeExpiredLibraries(input: TombstoneBatchInput): Promise<number> {
		validateInput(input);
		return this.transaction(async (client) => {
			const candidates = await client.query<{
				id: string;
				organization_id: string;
				workspace_id: string;
			}>(
				`SELECT library.id, library.organization_id, library.workspace_id
				 FROM app.libraries AS library
				 WHERE ${libraryEligibility()}
				 ORDER BY library.updated_at, library.id
				 LIMIT $2
				 FOR UPDATE OF library SKIP LOCKED`,
				[input.before, input.limit],
			);
			const ids = candidates.rows.map((row) => row.id);
			if (ids.length === 0) return 0;
			await client.query(
				`INSERT INTO app.audit_logs (
					organization_id, workspace_id, action, resource_type,
					resource_id, details
				)
				SELECT library.organization_id, library.workspace_id,
				       'library.tombstone_purged', 'library', library.id::text,
				       jsonb_build_object('retention_before', $2::timestamptz)
				FROM app.libraries AS library
				WHERE library.id = ANY($1::uuid[])`,
				[ids, input.before],
			);
			const deleted = await client.query<{ id: string }>(
				`DELETE FROM app.libraries AS library
				 WHERE library.id = ANY($1::uuid[])
				   AND ${libraryEligibility("$2")}
				 RETURNING library.id`,
				[ids, input.before],
			);
			return deleted.rowCount ?? 0;
		});
	}

	private async countLibraries(
		input: TombstoneBatchInput,
		condition: string,
	): Promise<number> {
		const result = await this.pool.query<{ count: number }>(
			`SELECT count(*)::integer AS count
			 FROM (
				 SELECT library.id
				 FROM app.libraries AS library
				 WHERE ${condition}
				 ORDER BY library.updated_at, library.id
				 LIMIT $2
			 ) AS candidates`,
			[input.before, input.limit],
		);
		return Number(result.rows[0]?.count ?? 0);
	}

	private async transaction<T>(
		operation: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
}
