import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
	return readFile(new URL(path, root), "utf8");
}

test("new bootstrap administrators must replace their unique initial password", async () => {
	const [migration, bootstrap, example, install, init, smoke] =
		await Promise.all([
			source("drizzle/0023_misty_the_initiative.sql"),
			source("scripts/bootstrap-control-plane.mjs"),
			source("deploy/config/bootstrap.env.example"),
			source("deploy/compose/scripts/install.sh"),
			source("deploy/compose/scripts/init-config.sh"),
			source("deploy/compose/scripts/pilot-smoke.sh"),
		]);

	assert.match(migration, /must_change_password.*DEFAULT false NOT NULL/);
	assert.match(bootstrap, /must_change_password/);
	assert.match(bootstrap, /VALUES \(\$1, \$2, true\)/);
	assert.match(bootstrap, /must_change_password = true/);
	assert.match(bootstrap, /adminPassword\.length < 7/);
	assert.match(bootstrap, /!\/\[a-z\]\//);
	assert.match(bootstrap, /!\/\[A-Z\]\//);
	assert.match(example, /^UNORAG_ADMIN_EMAIL=admin@unorag\.local$/m);
	assert.match(example, /^UNORAG_ADMIN_PASSWORD=$/m);
	assert.match(init, /\/dev\/urandom/);
	assert.match(init, /generated a unique initial administrator password/);
	assert.match(install, /change required at first login/);
	assert.match(smoke, /mustChangePassword/);
	assert.match(smoke, /\/api\/auth\/password/);
	assert.match(smoke, /\.smoke-admin-password/);
});

test("password change has an authenticated API and clears the bootstrap gate", async () => {
	const [route, session, page, form, layout, proxy] = await Promise.all([
		source("src/app/api/auth/password/route.ts"),
		source("src/lib/server/auth/session.ts"),
		source("src/app/change-password/page.tsx"),
		source("src/components/app/change-password-form.tsx"),
		source("src/app/app/layout.tsx"),
		source("src/proxy.ts"),
	]);

	assert.match(route, /allowPasswordChangeRequired: true/);
	assert.match(route, /changeLocalPassword/);
	assert.match(route, /createSessionToken\(result\.identity\)/);
	assert.match(session, /validatePassword\(input\.newPassword\)/);
	assert.match(session, /mustChangePassword: false/);
	assert.match(session, /auth\.password_changed/);
	assert.match(page, /identity\.mustChangePassword/);
	assert.match(form, /\/api\/auth\/password/);
	assert.match(layout, /redirect\("\/change-password"\)/);
	assert.match(proxy, /claims\.must_change_password/);
});
