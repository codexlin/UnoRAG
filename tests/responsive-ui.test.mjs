import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Ask evidence uses a mobile sheet and a responsive desktop rail", () => {
	const ask = readFileSync(
		path.join(root, "src/components/app/ask-workspace.tsx"),
		"utf8",
	);

	assert.match(ask, /useIsMobile/);
	assert.match(ask, /isMobile\s*\?\s*\(/);
	assert.match(ask, /<Sheet open=\{drawerOpen\}/);
	assert.match(ask, /data-\[side=right\]:w-\[min\(92vw,384px\)\]/);
	assert.match(ask, /hidden shrink-0[\s\S]*md:block/);
	assert.match(ask, /width: drawerOpen \? 384 : 0/);
	assert.match(ask, /useReducedMotion/);
});

test("public landing page describes the shipped product rather than a scaffold", () => {
	const page = readFileSync(path.join(root, "src/app/page.tsx"), "utf8");

	assert.match(page, /PRIVATE DEPLOYMENT · V1/);
	assert.match(page, /Enterprise Knowledge Infrastructure/);
	assert.match(page, /landing-evidence-desk\.png/);
	assert.match(page, /product-library-workbench\.png/);
	assert.match(page, /Retrieve \/ Ask API/);
	assert.match(page, /先让一份真实资料开口说话/);
	assert.doesNotMatch(page, /v0 · scaffold/);
});

test("settings grid lets the audit table scroll without widening the page", () => {
	const settings = readFileSync(
		path.join(root, "src/app/app/settings/page.tsx"),
		"utf8",
	);
	const audit = readFileSync(
		path.join(root, "src/components/app/workspace-audit-panel.tsx"),
		"utf8",
	);

	assert.match(settings, /\[&>\*\]:min-w-0/);
	assert.match(audit, /min-w-0 space-y-4/);
	assert.match(audit, /max-w-full overflow-x-auto/);
});

test("user menu keeps release metadata inside a Base UI menu group", () => {
	const navUser = readFileSync(
		path.join(root, "src/components/app/app-nav-user.tsx"),
		"utf8",
	);
	const releaseLabel = navUser.indexOf(">UnoRAG</span>");
	const groupStart = navUser.lastIndexOf("<DropdownMenuGroup>", releaseLabel);
	const groupEnd = navUser.indexOf("</DropdownMenuGroup>", releaseLabel);

	assert.ok(
		releaseLabel >= 0,
		"release label must be rendered in the user menu",
	);
	assert.ok(groupStart >= 0, "release label must have an enclosing menu group");
	assert.ok(
		groupEnd > releaseLabel,
		"release label must close inside its menu group",
	);
});

test("libraries use a mobile picker and preserve the desktop registry", () => {
	const libraries = readFileSync(
		path.join(root, "src/components/app/libraries-panel.tsx"),
		"utf8",
	);

	assert.match(libraries, /flex-col md:flex-row/);
	assert.match(libraries, /hidden w-72[\s\S]*md:flex/);
	assert.match(libraries, /<LibraryCombobox[\s\S]*label="当前知识库"/);
	assert.match(libraries, /className="border-b[^"]*md:hidden"/);
	assert.doesNotMatch(libraries, /资料空间/);
	assert.match(libraries, /max-w-full overflow-x-auto rounded-md border/);
	assert.match(libraries, /table-fixed md:table-auto/);
	assert.match(libraries, /hidden md:table-cell/);
	assert.match(libraries, /w-24 md:w-auto/);
	assert.match(libraries, /aria-label="搜索文档"/);
	assert.match(libraries, /documentSummary\.ready/);
	assert.match(libraries, /filteredDocuments\.map/);
});

test("deleted archive library requires an explicit replacement selection", () => {
	const ask = readFileSync(
		path.join(root, "src/components/app/ask-workspace.tsx"),
		"utf8",
	);

	assert.match(ask, /resumeLibraryMissing/);
	assert.match(ask, /原知识库已删除/);
	assert.match(ask, /setResumeLibraryMissing\(null\)/);
	assert.match(ask, /onValueChange=\{\(nextId\)/);
});

test("settings labels hybrid health as a global default", () => {
	const settings = readFileSync(
		path.join(root, "src/app/app/settings/page.tsx"),
		"utf8",
	);
	assert.match(settings, /全局默认混合检索/);
	assert.match(settings, /自动策略可按问法开启/);
});

test("Ask keeps the initial health probe distinct from an outage", () => {
	const ask = readFileSync(
		path.join(root, "src/components/app/ask-workspace.tsx"),
		"utf8",
	);
	assert.match(ask, /loading: healthLoading/);
	assert.match(ask, /服务状态 · 探测中/);
	assert.match(ask, /正在检查服务状态/);
	assert.match(ask, /正在连接知识库服务/);
});

test("replace copy matches desired to active atomic version behavior", () => {
	const libraries = readFileSync(
		path.join(root, "src/components/app/libraries-panel.tsx"),
		"utf8",
	);
	assert.match(libraries, /新版本索引成功前继续服务当前活跃版本/);
	assert.match(libraries, /成功后原子切换/);
	assert.match(libraries, /旧版本保留在版本历史中/);
	assert.doesNotMatch(libraries, /此操作不可恢复旧版内容/);
});

test("operations center is scoped, responsive, and permission-gated", () => {
	const operations = readFileSync(
		path.join(root, "src/components/app/operations-dashboard.tsx"),
		"utf8",
	);
	const nav = readFileSync(
		path.join(root, "src/components/app/nav-items.ts"),
		"utf8",
	);
	const sidebar = readFileSync(
		path.join(root, "src/components/app/app-sidebar.tsx"),
		"utf8",
	);

	assert.match(operations, /useCan\("manageMembers"\)/);
	assert.match(operations, /\/api\/workspace\/operations/);
	assert.match(operations, /overflow-x-auto/);
	assert.match(operations, /min-w-\[44rem\]/);
	assert.match(nav, /href: "\/app\/operations"[\s\S]*cap: "manageMembers"/);
	assert.match(sidebar, /allowsCap\(caps, item\.cap\)/);
});
