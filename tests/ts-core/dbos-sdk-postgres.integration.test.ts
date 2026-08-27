import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";

const databaseUrl = process.env.DBOS_SDK_TEST_DATABASE_URL?.trim();

test("DBOS executes and replays a queued workflow against PostgreSQL", {
	skip: databaseUrl ? false : "DBOS_SDK_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const suffix = randomUUID();
	const queue = new WorkflowQueue(`unorag-sdk-test-${suffix}`, {
		workerConcurrency: 1,
		minPollingIntervalMs: 10,
	});
	DBOS.setConfig({
		name: `unorag-sdk-test-${suffix}`,
		systemDatabaseUrl: databaseUrl,
		systemDatabasePoolSize: 4,
		applicationVersion: `integration-${suffix}`,
		executorID: `integration-${suffix}`,
		logLevel: "warn",
		tracingEnabled: false,
		enableOTLP: false,
		runAdminServer: false,
		listenQueues: [queue],
	});

	const workflow = DBOS.registerWorkflow(
		async (input: { value: number }) => ({
			value: await DBOS.runStep(async () => input.value + 1, {
				name: "increment",
			}),
		}),
		{ name: `unoragSdkIntegrationTest${suffix.replaceAll("-", "")}` },
	);

	await DBOS.launch();
	try {
		const workflowID = `dbos-sdk-integration-${suffix}`;
		const first = await DBOS.startWorkflow(workflow, {
			workflowID,
			queueName: queue.name,
		})({ value: 41 });
		assert.deepEqual(await first.getResult(), { value: 42 });

		const status = await DBOS.getWorkflowStatus(workflowID);
		assert.equal(status?.status, "SUCCESS");

		const replay = await DBOS.startWorkflow(workflow, {
			workflowID,
			queueName: queue.name,
		})({ value: 41 });
		assert.deepEqual(await replay.getResult(), { value: 42 });
	} finally {
		await DBOS.shutdown({ deregister: true });
	}
});
