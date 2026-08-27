import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("Compose keeps OIDC secrets scoped to Web and validates auth before changes", () => {
	const compose = read("deploy/compose/docker-compose.yml");
	const helpers = read("deploy/compose/scripts/compose-env.sh");
	const install = read("deploy/compose/scripts/install.sh");
	const upgrade = read("deploy/compose/scripts/upgrade.sh");
	assert.match(compose, /web:[\s\S]*OIDC_CLIENT_SECRET:/);
	assert.equal((compose.match(/^\s+OIDC_CLIENT_SECRET:/gm) ?? []).length, 1);
	assert.match(helpers, /mk_validate_auth_config\(\)/);
	assert.match(helpers, /at least one of LOCAL_AUTH_ENABLED or OIDC_ENABLED/);
	assert.match(helpers, /APP_BASE_URL must be an HTTPS origin/);
	assert.match(install, /mk_validate_auth_config/);
	assert.match(upgrade, /mk_validate_auth_config/);
});

test("Helm exposes OIDC public config and injects only its client secret", () => {
	const values = read("deploy/helm/unorag/values.yaml");
	const configmap = read("deploy/helm/unorag/templates/configmap.yaml");
	const deployment = read("deploy/helm/unorag/templates/web-deployment.yaml");
	assert.match(values, /auth:[\s\S]*oidc:[\s\S]*enabled: false/);
	assert.match(configmap, /OIDC_ISSUER_URL/);
	assert.match(configmap, /at least one authentication method must be enabled/);
	assert.match(deployment, /name: OIDC_CLIENT_SECRET/);
});
