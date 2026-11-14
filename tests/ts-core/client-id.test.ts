import assert from "node:assert/strict";
import test from "node:test";
import { createClientId } from "../../src/lib/client-id";

test("client IDs prefer native UUID generation when available", () => {
	const native = "e0bc012c-3b66-4e0b-aaca-73ec6b4fd50b";
	assert.equal(
		createClientId({
			randomUUID: () => native,
			getRandomValues: () => {
				throw new Error("unexpected fallback");
			},
		}),
		native,
	);
});

test("client IDs preserve v4 and variant bits without the secure-context UUID method", () => {
	for (const [byte, expected] of [
		[0, "00000000-0000-4000-8000-000000000000"],
		[255, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
	] as const) {
		const id = createClientId({
			getRandomValues: <T extends ArrayBufferView | null>(target: T): T => {
				assert.ok(target instanceof Uint8Array);
				assert.equal(target.length, 16);
				target.fill(byte);
				return target;
			},
		});
		assert.equal(id, expected);
	}
});

test("client IDs remain independent and never fall back to weak randomness", () => {
	const ids = new Set(
		Array.from({ length: 100 }, () =>
			createClientId({
				getRandomValues: globalThis.crypto.getRandomValues.bind(
					globalThis.crypto,
				),
			}),
		),
	);
	assert.equal(ids.size, 100);
	assert.throws(
		() => createClientId({ getRandomValues: undefined } as unknown as Crypto),
		/cryptographic random/,
	);
});
