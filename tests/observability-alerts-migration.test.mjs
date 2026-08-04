import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
	new URL("../drizzle/0022_easy_synch.sql", import.meta.url),
	"utf8",
);

test("observability migration scopes health, state, transitions and delivery", () => {
	for (const table of [
		"observability_component_health",
		"observability_alerts",
		"observability_alert_transitions",
		"observability_alert_deliveries",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE "app"."${table}"`));
	}
	assert.match(
		migration,
		/FOREIGN KEY \("organization_id","workspace_id","transition_id"\)/,
	);
	assert.match(
		migration,
		/UNIQUE INDEX "observability_alert_delivery_transition_uq"[\s\S]*"transition_id","channel","destination_key","config_version"/,
	);
	assert.doesNotMatch(
		migration,
		/webhook_url|email_to|api_key|authorization|provider_response/i,
	);
});

test("composite unique indexes exist before dependent foreign keys", () => {
	const alertScope = migration.indexOf(
		'CREATE UNIQUE INDEX "observability_alerts_scope_id_uq"',
	);
	const transitionScope = migration.indexOf(
		'CREATE UNIQUE INDEX "observability_alert_transitions_scope_id_uq"',
	);
	const transitionForeignKey = migration.indexOf(
		'ADD CONSTRAINT "observability_alert_transitions_scope_alert_fk"',
	);
	const deliveryForeignKey = migration.indexOf(
		'ADD CONSTRAINT "observability_alert_deliveries_scope_transition_fk"',
	);
	assert.ok(alertScope >= 0 && alertScope < transitionForeignKey);
	assert.ok(transitionScope >= 0 && transitionScope < deliveryForeignKey);
});

test("upgrade migration grants least-privilege runtime access", () => {
	assert.match(migration, /rolname = 'unorag_web'/);
	assert.match(migration, /rolname = 'unorag_worker'/);
	assert.match(
		migration,
		/GRANT INSERT, UPDATE ON app\.observability_alert_deliveries TO unorag_worker/,
	);
	assert.doesNotMatch(
		migration,
		/GRANT (?:ALL|INSERT|UPDATE|DELETE)[^;]*TO unorag_web/i,
	);
});
