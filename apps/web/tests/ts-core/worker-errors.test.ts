import assert from "node:assert/strict";
import test from "node:test";

import { ParserProviderHttpError } from "../../src/core/parsing";
import { classifyWorkerError } from "../../src/worker/errors";

test("worker classification preserves parser provider retryability", () => {
	assert.deepEqual(
		classifyWorkerError(
			new ParserProviderHttpError({
				message: "MinerU rate limited",
				code: "provider_rate_limited",
				retryable: true,
				status: 429,
			}),
		),
		{
			category: "transient",
			code: "provider_rate_limited",
			message: "MinerU rate limited",
			retryable: true,
		},
	);
	assert.equal(
		classifyWorkerError(
			new ParserProviderHttpError({
				message: "MinerU credentials rejected",
				code: "provider_unauthorized",
				retryable: false,
				status: 401,
			}),
		).category,
		"permanent",
	);
});
