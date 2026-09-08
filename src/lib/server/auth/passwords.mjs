import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function validatePassword(password) {
	if (password.length < 7) {
		return "password must be at least 7 characters";
	}
	if (password.length > 256) {
		return "password must be at most 256 characters";
	}
	if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
		return "password must contain uppercase and lowercase letters";
	}
	return null;
}

export function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPasswordSync(password, encoded) {
	const [algorithm, saltHex, hashHex] = encoded.split("$");
	if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
	const expected = Buffer.from(hashHex, "hex");
	const actual = scryptSync(
		password,
		Buffer.from(saltHex, "hex"),
		expected.length,
	);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
