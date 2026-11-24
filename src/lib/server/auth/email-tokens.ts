import {
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";
import type { Pool } from "pg";

import { hashPasswordAsync, validatePassword } from "./passwords.mjs";

export const ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS = 5;

export type AccountEmailPurpose = "login" | "reset";
export type AccountEmailPrincipal = {
	userId: string;
	organizationId: string;
	workspaceId: string;
	credentialVersion: string;
};
export type ConsumeAccountEmailInput =
	| { token: string; purpose: AccountEmailPurpose; password?: string }
	| {
			email: string;
			code: string;
			purpose: AccountEmailPurpose;
			password?: string;
	  };

export function hashAccountEmailToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function generateAccountEmailCode(): string {
	return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Bind the 6-digit code hash to the row's 256-bit token hash to prevent offline lookup. */
export function hashAccountEmailCode(tokenHash: string, code: string): string {
	return createHash("sha256")
		.update(`otp:v1:${tokenHash}:${code}`)
		.digest("hex");
}

function codeHashesEqual(expectedHex: string, storedHex: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(storedHex))
		return false;
	return timingSafeEqual(
		Buffer.from(expectedHex, "hex"),
		Buffer.from(storedHex, "hex"),
	);
}

/** Account links only use the deployment URL, never Host / forwarded headers. */
export function accountEmailBaseUrl(value: string | undefined): string | null {
	try {
		const url = new URL(value ?? "");
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}

export function resolveAccountEmailBaseUrl(
	env: Record<string, string | undefined> = process.env,
): string | null {
	return accountEmailBaseUrl(env.APP_BASE_URL?.trim() || env.UNORAG_BASE_URL);
}

/** Preserve the explicitly configured origin for local development mutations. */
export function resolveMutationBaseUrl(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	return (
		env.APP_BASE_URL?.trim() ||
		accountEmailBaseUrl(env.UNORAG_BASE_URL) ||
		undefined
	);
}

export async function issueAccountEmailToken(
	pool: Pool,
	input: { email: string; purpose: AccountEmailPurpose; baseUrl: string },
	now = new Date(),
) {
	const baseUrl = accountEmailBaseUrl(input.baseUrl);
	if (!baseUrl) throw new Error("account_email_base_url_invalid");
	const email = input.email.trim().toLowerCase();
	// No implicit organization choice when more than one account has this address.
	const candidates = await pool.query<{ id: string }>(
		`SELECT u.id FROM app.users u
		 JOIN app.organizations o ON o.id = u.organization_id AND o.status = 'active'
		 JOIN app.local_credentials c ON c.user_id = u.id
		 WHERE lower(u.email) = $1 AND u.status = 'active'
		 AND EXISTS (SELECT 1 FROM app.workspace_members m JOIN app.workspaces w
		   ON w.id = m.workspace_id AND w.organization_id = u.organization_id AND w.status = 'active'
		   WHERE m.user_id = u.id) LIMIT 2`,
		[email],
	);
	if (candidates.rows.length !== 1) return null;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const account = await client.query<{
			id: string;
			organization_id: string;
			workspace_id: string;
			password_changed_at: Date;
		}>(
			`SELECT u.id, u.organization_id, c.password_changed_at,
			 (SELECT w.id FROM app.workspace_members m JOIN app.workspaces w
			  ON w.id = m.workspace_id AND w.organization_id = u.organization_id AND w.status = 'active'
			  WHERE m.user_id = u.id ORDER BY m.created_at, w.id LIMIT 1) AS workspace_id
			 FROM app.users u JOIN app.local_credentials c ON c.user_id = u.id
			 JOIN app.organizations o ON o.id = u.organization_id AND o.status = 'active'
			 WHERE u.id = $1 AND lower(u.email) = $2 AND u.status = 'active' FOR UPDATE OF c`,
			[candidates.rows[0].id, email],
		);
		const row = account.rows[0];
		if (!row?.workspace_id) {
			await client.query("ROLLBACK");
			return null;
		}
		await client.query(
			`DELETE FROM app.account_email_tokens WHERE user_id = $1
			 AND expires_at < $2::timestamptz - interval '1 day'`,
			[row.id, now],
		);
		await client.query(
			`UPDATE app.account_email_tokens SET consumed_at = $3
			 WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
			[row.id, input.purpose, now],
		);
		const rawToken = randomBytes(32).toString("base64url");
		const tokenHash = hashAccountEmailToken(rawToken);
		const rawCode = generateAccountEmailCode();
		const codeHash = hashAccountEmailCode(tokenHash, rawCode);
		const result = await client.query<{ id: string }>(
			`INSERT INTO app.account_email_tokens
			 (organization_id, workspace_id, user_id, email, purpose, token_hash, code_hash, code_attempts, credential_version, created_at, expires_at)
			 SELECT $1,$2,$3,$4,$5,$6,$7,0,c.password_changed_at,$8,$9
			 FROM app.local_credentials c WHERE c.user_id = $3 RETURNING id`,
			[
				row.organization_id,
				row.workspace_id,
				row.id,
				email,
				input.purpose,
				tokenHash,
				codeHash,
				now,
				new Date(now.getTime() + 15 * 60_000),
			],
		);
		await client.query("COMMIT");
		return {
			tokenId: result.rows[0].id,
			userId: row.id,
			organizationId: row.organization_id,
			workspaceId: row.workspace_id,
			url: `${baseUrl}/account-access#${new URLSearchParams({ token: rawToken, purpose: input.purpose })}`,
			code: rawCode,
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function consumeByLinkToken(
	pool: Pool,
	input: { token: string; purpose: AccountEmailPurpose; password?: string },
	now?: Date,
): Promise<AccountEmailPrincipal | null> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return null;
	if (
		input.purpose === "reset" &&
		(!input.password || validatePassword(input.password))
	)
		return null;
	const tokenHash = hashAccountEmailToken(input.token);
	let nextHash: string | null = null;
	if (input.purpose === "reset") {
		// Reject random/expired proofs before spending crypto resources. The locked
		// transaction below must still recheck validity after this asynchronous work.
		const proof = await pool.query(
			`SELECT 1 FROM app.account_email_tokens t JOIN app.local_credentials c ON c.user_id = t.user_id
			 WHERE t.token_hash = $1 AND t.purpose = 'reset' AND t.consumed_at IS NULL
			 AND t.expires_at > COALESCE($2::timestamptz, clock_timestamp()) AND t.credential_version = c.password_changed_at`,
			[tokenHash, now ?? null],
		);
		if (!proof.rowCount) return null;
		nextHash = await hashPasswordAsync(input.password as string);
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		// Credential -> token lock order is shared with issuance and password reset.
		const rows = await client.query<{
			user_id: string;
			organization_id: string;
			workspace_id: string;
			password_changed_at: Date;
		}>(
			`SELECT t.user_id, t.organization_id, t.workspace_id, c.password_changed_at
			 FROM app.account_email_tokens t
			 JOIN app.local_credentials c ON c.user_id = t.user_id
			 JOIN app.users u ON u.id = t.user_id AND u.organization_id = t.organization_id
			 JOIN app.organizations o ON o.id = t.organization_id AND o.status = 'active'
			 JOIN app.workspaces w ON w.id = t.workspace_id AND w.organization_id = t.organization_id AND w.status = 'active'
			 JOIN app.workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
			 WHERE t.token_hash = $1 AND t.purpose = $2 AND t.consumed_at IS NULL
			 AND t.expires_at > COALESCE($3::timestamptz, clock_timestamp()) AND t.credential_version = c.password_changed_at
			 AND u.status = 'active' AND lower(u.email) = t.email FOR UPDATE OF c`,
			[tokenHash, input.purpose, now ?? null],
		);
		const row = rows.rows[0];
		if (!row) {
			await client.query("ROLLBACK");
			return null;
		}
		// Recheck after waiting for a concurrent consumer's credential lock.
		const used = await client.query(
			`UPDATE app.account_email_tokens t SET consumed_at = COALESCE($3::timestamptz, clock_timestamp())
			 FROM app.local_credentials c
			 WHERE t.token_hash = $1 AND t.purpose = $2 AND t.consumed_at IS NULL
			 AND t.expires_at > COALESCE($3::timestamptz, clock_timestamp()) AND c.user_id = t.user_id AND c.password_changed_at = t.credential_version
			 RETURNING t.id`,
			[tokenHash, input.purpose, now ?? null],
		);
		if (used.rowCount !== 1) {
			await client.query("ROLLBACK");
			return null;
		}
		if (nextHash) {
			await client.query(
				`UPDATE app.local_credentials SET password_hash = $2, must_change_password = false,
				 failed_attempts = 0, locked_until = NULL,
				 password_changed_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), password_changed_at + interval '1 millisecond'),
				 updated_at = COALESCE($3::timestamptz, clock_timestamp()) WHERE user_id = $1`,
				[row.user_id, nextHash, now ?? null],
			);
			await client.query(
				"UPDATE app.account_email_tokens SET consumed_at = COALESCE($2::timestamptz, clock_timestamp()) WHERE user_id = $1 AND consumed_at IS NULL",
				[row.user_id, now ?? null],
			);
		}
		await client.query(
			`INSERT INTO app.audit_logs (organization_id, workspace_id, actor_id, action, resource_type, resource_id, details)
			 VALUES ($1,$2,$3::uuid,$4,'user',($3::uuid)::text,$5::jsonb)`,
			[
				row.organization_id,
				row.workspace_id,
				row.user_id,
				input.purpose === "reset" ? "auth.password_reset" : "auth.email_login",
				JSON.stringify({ method: "link" }),
			],
		);
		await client.query("COMMIT");
		return {
			userId: row.user_id,
			organizationId: row.organization_id,
			workspaceId: row.workspace_id,
			credentialVersion: String(row.password_changed_at.getTime()),
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function consumeByVerificationCode(
	pool: Pool,
	input: {
		email: string;
		code: string;
		purpose: AccountEmailPurpose;
		password?: string;
	},
	now?: Date,
): Promise<AccountEmailPrincipal | null> {
	const email = input.email.trim().toLowerCase();
	const code = input.code.trim();
	if (!email || !/^\d{6}$/.test(code)) return null;
	if (
		input.purpose === "reset" &&
		(!input.password || validatePassword(input.password))
	)
		return null;

	const candidates = await pool.query<{ id: string }>(
		`SELECT u.id FROM app.users u
		 JOIN app.organizations o ON o.id = u.organization_id AND o.status = 'active'
		 JOIN app.local_credentials c ON c.user_id = u.id
		 WHERE lower(u.email) = $1 AND u.status = 'active' LIMIT 2`,
		[email],
	);
	if (candidates.rows.length !== 1) return null;
	const candidateUserId = candidates.rows[0].id;

	let nextHash: string | null = null;
	if (input.purpose === "reset") {
		const proof = await pool.query<{
			token_hash: string;
			code_hash: string | null;
		}>(
			`SELECT t.token_hash, t.code_hash
			 FROM app.account_email_tokens t
			 JOIN app.local_credentials c ON c.user_id = t.user_id
			 WHERE t.user_id = $1 AND t.purpose = 'reset' AND t.consumed_at IS NULL
			 AND t.code_hash IS NOT NULL AND t.code_attempts < $2
			 AND t.expires_at > COALESCE($3::timestamptz, clock_timestamp())
			 AND t.credential_version = c.password_changed_at
			 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
			[candidateUserId, ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS, now ?? null],
		);
		const precheck = proof.rows[0];
		if (!precheck?.code_hash) return null;
		if (
			codeHashesEqual(
				hashAccountEmailCode(precheck.token_hash, code),
				precheck.code_hash,
			)
		) {
			nextHash = await hashPasswordAsync(input.password as string);
		}
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		// Shared lock order: credential first, then active token row.
		const locked = await client.query<{
			user_id: string;
			organization_id: string;
			password_changed_at: Date;
		}>(
			`SELECT u.id AS user_id, u.organization_id, c.password_changed_at
			 FROM app.users u
			 JOIN app.local_credentials c ON c.user_id = u.id
			 JOIN app.organizations o ON o.id = u.organization_id AND o.status = 'active'
			 WHERE u.id = $1 AND lower(u.email) = $2 AND u.status = 'active' FOR UPDATE OF c`,
			[candidateUserId, email],
		);
		const account = locked.rows[0];
		if (!account) {
			await client.query("ROLLBACK");
			return null;
		}
		const tokenRows = await client.query<{
			id: string;
			workspace_id: string;
			token_hash: string;
			code_hash: string;
			code_attempts: number;
		}>(
			`SELECT t.id, t.workspace_id, t.token_hash, t.code_hash, t.code_attempts
			 FROM app.account_email_tokens t
			 JOIN app.workspaces w ON w.id = t.workspace_id AND w.organization_id = t.organization_id AND w.status = 'active'
			 JOIN app.workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
			 WHERE t.user_id = $1 AND t.organization_id = $2 AND t.email = $3 AND t.purpose = $4
			 AND t.consumed_at IS NULL AND t.code_hash IS NOT NULL AND t.code_attempts < $5
			 AND t.expires_at > COALESCE($6::timestamptz, clock_timestamp())
			 AND t.credential_version = $7
			 ORDER BY t.created_at DESC, t.id DESC LIMIT 1 FOR UPDATE OF t`,
			[
				account.user_id,
				account.organization_id,
				email,
				input.purpose,
				ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS,
				now ?? null,
				account.password_changed_at,
			],
		);
		const tokenRow = tokenRows.rows[0];
		if (!tokenRow) {
			await client.query("ROLLBACK");
			return null;
		}
		const matches = codeHashesEqual(
			hashAccountEmailCode(tokenRow.token_hash, code),
			tokenRow.code_hash,
		);
		if (!matches) {
			await client.query(
				`UPDATE app.account_email_tokens
				 SET code_attempts = code_attempts + 1,
				     consumed_at = CASE
				       WHEN code_attempts + 1 >= $2
				       THEN COALESCE($3::timestamptz, clock_timestamp())
				       ELSE NULL
				     END
				 WHERE id = $1 AND consumed_at IS NULL AND code_attempts < $2`,
				[tokenRow.id, ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS, now ?? null],
			);
			await client.query("COMMIT");
			return null;
		}

		if (input.purpose === "reset" && !nextHash) {
			nextHash = await hashPasswordAsync(input.password as string);
		}
		const used = await client.query(
			`UPDATE app.account_email_tokens
			 SET consumed_at = COALESCE($2::timestamptz, clock_timestamp())
			 WHERE id = $1 AND consumed_at IS NULL AND code_attempts < $3
			 AND expires_at > COALESCE($2::timestamptz, clock_timestamp())
			 RETURNING id`,
			[tokenRow.id, now ?? null, ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS],
		);
		if (used.rowCount !== 1) {
			await client.query("ROLLBACK");
			return null;
		}
		if (nextHash) {
			await client.query(
				`UPDATE app.local_credentials SET password_hash = $2, must_change_password = false,
				 failed_attempts = 0, locked_until = NULL,
				 password_changed_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), password_changed_at + interval '1 millisecond'),
				 updated_at = COALESCE($3::timestamptz, clock_timestamp()) WHERE user_id = $1`,
				[account.user_id, nextHash, now ?? null],
			);
			await client.query(
				"UPDATE app.account_email_tokens SET consumed_at = COALESCE($2::timestamptz, clock_timestamp()) WHERE user_id = $1 AND consumed_at IS NULL",
				[account.user_id, now ?? null],
			);
		}
		await client.query(
			`INSERT INTO app.audit_logs (organization_id, workspace_id, actor_id, action, resource_type, resource_id, details)
			 VALUES ($1,$2,$3::uuid,$4,'user',($3::uuid)::text,$5::jsonb)`,
			[
				account.organization_id,
				tokenRow.workspace_id,
				account.user_id,
				input.purpose === "reset" ? "auth.password_reset" : "auth.email_login",
				JSON.stringify({ method: "code" }),
			],
		);
		await client.query("COMMIT");
		return {
			userId: account.user_id,
			organizationId: account.organization_id,
			workspaceId: tokenRow.workspace_id,
			credentialVersion: String(account.password_changed_at.getTime()),
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function consumeAccountEmailToken(
	pool: Pool,
	input: ConsumeAccountEmailInput,
	now?: Date,
): Promise<AccountEmailPrincipal | null> {
	if ("token" in input) {
		return consumeByLinkToken(pool, input, now);
	}
	return consumeByVerificationCode(pool, input, now);
}
