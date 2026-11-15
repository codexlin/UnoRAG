import assert from "node:assert/strict";
import test from "node:test";

import { sparseVector } from "../../src/core/retrieval/hybrid/sparse-vector";

test("sparse lexical vectors use stable UTF-8 FNV-1a indices and log TF", () => {
	assert.deepEqual(sparseVector("Hello hello"), {
		indices: [1335831723],
		values: [1 + Math.log(2)],
	});
	assert.deepEqual(sparseVector("HELLO hello"), sparseVector("hello HELLO"));
	assert.deepEqual(sparseVector("合同"), sparseVector("合同"));
	assert.equal(sparseVector("合同").indices.length, 3);
	const vector = sparseVector("合同违约金 ZXQ987 abc abc");
	assert.equal(vector.indices.length, new Set(vector.indices).size);
	assert.deepEqual(
		vector.indices,
		[...vector.indices].sort((a, b) => a - b),
	);
	assert.ok(
		vector.indices.every(
			(index) => Number.isInteger(index) && index >= 0 && index <= 0xffffffff,
		),
	);
	assert.ok(
		vector.values.every((value) => Number.isFinite(value) && value > 0),
	);
	assert.deepEqual(sparseVector("! \n 🦉"), { indices: [], values: [] });
});

test("hash collisions merge counts without duplicate dimensions", () => {
	// A known FNV-1a collision among ASCII tokenizer terms.
	assert.deepEqual(sparseVector("costarring liquid"), {
		indices: [1582148253],
		values: [1 + Math.log(2)],
	});
});
