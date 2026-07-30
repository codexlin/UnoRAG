import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
	ASK_GRAPH_NODE_NAMES,
	ASK_STATE_FIELD_NAMES,
	AskStateSchema,
	AuthorizedScopeSchema,
	RetrievalPlanSchema,
} from "../../src/core/contracts";

const askFixtureUrl = new URL(
	"../fixtures/ts-core/python-ask-contract-v1.json",
	import.meta.url,
);

test("authorized scope fails closed when mandatory dimensions are missing", () => {
	assert.equal(
		AuthorizedScopeSchema.safeParse({
			organizationId: "org-1",
			workspaceId: "workspace-1",
			principalIds: ["user-1"],
			libraryIds: ["library-1"],
		}).success,
		false,
	);

	assert.equal(
		AuthorizedScopeSchema.safeParse({
			organizationId: "org-1",
			workspaceId: "workspace-1",
			principalIds: ["user-1"],
			libraryIds: ["library-1"],
			activeGenerationIds: [],
		}).success,
		true,
	);
});

test("retrieval plan rejects model-invented security filters", () => {
	assert.equal(
		RetrievalPlanSchema.safeParse({
			semantic_query: "contract penalty",
			filters: { tenant_id: "other-tenant" },
		}).success,
		false,
	);
});

test("Ask state accepts the current Python graph surface", () => {
	assert.equal(
		AskStateSchema.safeParse({
			session_id: "session-1",
			question: "What is the penalty?",
			query_type: "fact",
			retrieval_plan: { path: "fast" },
			judgement: { action: "generate" },
		}).success,
		true,
	);
});

test("Ask state fields and node names match the exported Python source", async () => {
	const fixture = JSON.parse(await readFile(askFixtureUrl, "utf8")) as {
		node_names: string[];
		state_fields: string[];
	};

	assert.deepEqual([...ASK_GRAPH_NODE_NAMES], fixture.node_names);
	assert.deepEqual([...ASK_STATE_FIELD_NAMES], fixture.state_fields);
});
