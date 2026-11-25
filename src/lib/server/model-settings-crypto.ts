import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import type { ModelSlot } from "@/lib/model-settings";
import { resolveSessionSecret } from "@/lib/server/auth/secrets.mjs";

const CIPHER_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_ENCRYPTION_KEY_LENGTH = 32;
const HKDF_SALT = Buffer.from("unorag-model-settings-v1", "utf8");
const HKDF_INFO = Buffer.from("api-key-envelope-encryption", "utf8");

function hkdfFromSecret(secret: string): Buffer {
	return Buffer.from(
		hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, HKDF_INFO, 32),
	);
}

function resolvePrimarySourceSecret(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const dedicated = env.MODEL_SETTINGS_ENCRYPTION_KEY?.trim();
	if (dedicated !== undefined && dedicated.length > 0) {
		if (dedicated.length < MIN_ENCRYPTION_KEY_LENGTH) {
			throw new Error(
				`MODEL_SETTINGS_ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters`,
			);
		}
		return dedicated;
	}
	return resolveSessionSecret(env);
}

function deriveEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
	return hkdfFromSecret(resolvePrimarySourceSecret(env));
}

function deriveDecryptionKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
	const primarySecret = resolvePrimarySourceSecret(env);
	const keys = [hkdfFromSecret(primarySecret)];
	const previous = env.MODEL_SETTINGS_ENCRYPTION_KEY_PREVIOUS?.trim();
	if (previous !== undefined && previous.length > 0) {
		if (previous.length < MIN_ENCRYPTION_KEY_LENGTH) {
			throw new Error(
				`MODEL_SETTINGS_ENCRYPTION_KEY_PREVIOUS must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters`,
			);
		}
		if (previous !== primarySecret) {
			keys.push(hkdfFromSecret(previous));
		}
	}
	return keys;
}

function buildAad(organizationId: string, slot: ModelSlot): Buffer {
	return Buffer.from(`unorag:${organizationId}:${slot}`, "utf8");
}

export function encryptModelApiKey(
	plaintext: string,
	context: { organizationId: string; slot: ModelSlot },
	env: NodeJS.ProcessEnv = process.env,
): string {
	const trimmed = plaintext.trim();
	if (!trimmed) {
		throw new Error("cannot encrypt empty model API key");
	}
	const key = deriveEncryptionKey(env);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: TAG_BYTES,
	});
	cipher.setAAD(buildAad(context.organizationId, context.slot));
	const encrypted = Buffer.concat([
		cipher.update(trimmed, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return [
		CIPHER_VERSION,
		iv.toString("base64url"),
		tag.toString("base64url"),
		encrypted.toString("base64url"),
	].join(":");
}

export function decryptModelApiKey(
	ciphertext: string,
	context: { organizationId: string; slot: ModelSlot },
	env: NodeJS.ProcessEnv = process.env,
): string {
	const parts = ciphertext.split(":");
	if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
		throw new Error("invalid encrypted model API key envelope");
	}
	const [, ivB64, tagB64, bodyB64] = parts;
	const iv = Buffer.from(ivB64, "base64url");
	const tag = Buffer.from(tagB64, "base64url");
	const body = Buffer.from(bodyB64, "base64url");
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || body.length === 0) {
		throw new Error("malformed encrypted model API key envelope");
	}
	const keys = deriveDecryptionKeys(env);
	const aad = buildAad(context.organizationId, context.slot);
	let lastError: unknown;
	for (const key of keys) {
		try {
			const decipher = createDecipheriv(ALGORITHM, key, iv, {
				authTagLength: TAG_BYTES,
			});
			decipher.setAAD(aad);
			decipher.setAuthTag(tag);
			const decrypted = Buffer.concat([
				decipher.update(body),
				decipher.final(),
			]);
			return decrypted.toString("utf8");
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("failed to decrypt model API key");
}

export function maskApiKeyHint(plaintext: string): string {
	const trimmed = plaintext.trim();
	if (trimmed.length >= 12) {
		return `••••${trimmed.slice(-4)}`;
	}
	return "••••";
}
