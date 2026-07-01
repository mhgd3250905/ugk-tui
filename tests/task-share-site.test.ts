import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve("docs", "task-share");
const requiredFiles = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];

async function readJson(filePath: string) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

function zipEntryNames(filePath: string) {
	const data = readFileSync(filePath);
	const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.notEqual(eocd, -1, `${filePath} should have a ZIP directory`);
	const count = data.readUInt16LE(eocd + 10);
	let offset = data.readUInt32LE(eocd + 16);
	const names = [];
	for (let index = 0; index < count; index++) {
		assert.equal(data.readUInt32LE(offset), 0x02014b50);
		const nameLength = data.readUInt16LE(offset + 28);
		const extraLength = data.readUInt16LE(offset + 30);
		const commentLength = data.readUInt16LE(offset + 32);
		names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return names.sort();
}

function runGeneratedSafeHref(html: string, url: string) {
	const script = html.match(/<script>([\s\S]*)<\/script><\/body><\/html>$/)?.[1] ?? "";
	const escLine = script.split("\n").find((line) => line.startsWith("function esc("));
	const safeHrefLine = script.split("\n").find((line) => line.startsWith("function safeHref("));
	assert.ok(escLine, "generated script should define esc");
	assert.ok(safeHrefLine, "generated script should define safeHref");
	const context = { result: "" };
	vm.runInNewContext(`${escLine}\n${safeHrefLine}\nresult=safeHref(${JSON.stringify(url)});`, context);
	return context.result;
}

test("task share manifest describes official taskbooks with matching local files", async () => {
	const manifest = await readJson(path.join(root, "manifest.json"));

	assert.equal(manifest.version, 1);
	assert.ok(Array.isArray(manifest.tasks));
	assert.ok(manifest.tasks.length >= 11);
	assert.ok(manifest.tasks.some((task) => Object.keys(task.files).some((file) => file.startsWith("scripts/"))));

	for (const task of manifest.tasks) {
		assert.match(task.name, /^[A-Za-z0-9_-]+$/);
		assert.equal(task.install, `ugk task install ${task.name}`);
		assert.equal(task.version, "1.0.0");
		assert.equal(task.versions[0].version, "1.0.0");
		assert.equal(task.zip, `downloads/${task.name}.zip`);
		assert.equal(task.author, "UGK Official");
		assert.equal(task.stats.downloads, 0);
		assert.equal(task.stats.likes, 0);
		assert.equal(task.stats.favorites, 0);
		assert.equal(typeof task.description, "string");
		assert.equal(typeof task.exampleInput, "string");
		assert.equal(typeof task.files, "object");

		const taskDir = path.join(root, "taskbooks", task.name);
		for (const file of Object.keys(task.files)) {
			const localPath = path.join(taskDir, file);
			assert.equal(existsSync(localPath), true, `${localPath} should exist`);
			assert.equal(task.files[file], `https://ugk-task-share.pages.dev/taskbooks/${task.name}/${file}`);
		}
		for (const file of requiredFiles) assert.equal(typeof task.files[file], "string");

		const taskbook = await readJson(path.join(taskDir, "taskbook.json"));
		const spec = await readJson(path.join(taskDir, "spec.json"));
		const contract = await readJson(path.join(taskDir, "contract.json"));
		assert.equal(taskbook.name, task.name);
		assert.equal(taskbook.scope, "user");
		assert.equal(spec.goal, task.description);
		assert.ok(Array.isArray(contract.runtimeInput));
	}
});

test("task share page exposes marketplace actions for every official task", async () => {
	const [manifest, html] = await Promise.all([
		readJson(path.join(root, "manifest.json")),
		readFile(path.join(root, "index.html"), "utf8"),
	]);

	assert.match(html, /Sign in with GitHub/);
	assert.match(html, /api\/auth\/github/);
	assert.match(html, /api\/tasks\/.*\/like/);
	assert.match(html, /api\/tasks\/.*\/favorite/);
	assert.match(html, /api\/tasks\/.*\/download/);
	assert.match(html, /api\/session/);
	assert.match(html, /api\/account\/favorites/);
	assert.match(html, /api\/community\/tasks/);
	assert.match(html, /upload\//);
	assert.match(html, /data-sort/);
	assert.match(html, /data-category-filter/);
	assert.match(html, /data-action="report"/);
	assert.match(html, /encodeURIComponent\(name\)\+'\/stats/);
	assert.match(html, /api\/stats/);
	assert.match(html, /account\//);
	assert.match(html, /<svg class="icon"/);
	assert.doesNotMatch(html, />Like<\/button>/);
	assert.doesNotMatch(html, />Favorite<\/button>/);
	assert.doesNotMatch(html, /Seed downloads|Seed likes/);

	const accountPath = path.join(root, "account", "index.html");
	assert.equal(existsSync(accountPath), true, `${accountPath} should exist`);
	const account = await readFile(accountPath, "utf8");
	assert.match(account, /data-account-page/);
	assert.match(account, /api\/account\/favorites/);
	assert.match(account, /api\/account\/submissions/);
	assert.match(account, /api\/account\/downloads/);

	const uploadPath = path.join(root, "upload", "index.html");
	assert.equal(existsSync(uploadPath), true, `${uploadPath} should exist`);
	const upload = await readFile(uploadPath, "utf8");
	assert.match(upload, /data-upload-form/);
	assert.match(upload, /api\/tasks\/submit/);

	const adminPath = path.join(root, "admin", "index.html");
	assert.equal(existsSync(adminPath), true, `${adminPath} should exist`);
	const admin = await readFile(adminPath, "utf8");
	assert.match(admin, /data-admin-page/);
	assert.match(admin, /api\/admin\/submissions/);
	assert.match(admin, /api\/admin\/reports/);

	for (const task of manifest.tasks) {
		assert.match(html, new RegExp(`ugk task install ${task.name}`));
		assert.match(html, new RegExp(`downloads/${task.name}\\.zip`));
		assert.match(html, new RegExp(`tasks/${task.name}/`));
		assert.match(html, new RegExp(task.title));

		const detailPath = path.join(root, "tasks", task.name, "index.html");
		assert.equal(existsSync(detailPath), true, `${detailPath} should exist`);
		const detail = await readFile(detailPath, "utf8");
		assert.match(detail, new RegExp(`ugk task install ${task.name}`));
		assert.match(detail, new RegExp(task.author));
		assert.match(detail, /Sign in with GitHub/);
		assert.match(detail, /data-action="like"/);
		assert.match(detail, /data-action="favorite"/);
		assert.match(detail, /data-action="report"/);
		assert.match(detail, /stats-detail/);
		assert.match(detail, /versions/);
		assert.doesNotMatch(detail, />Like<\/button>/);
		assert.doesNotMatch(detail, />Favorite<\/button>/);

		const zipPath = path.join(root, "downloads", `${task.name}.zip`);
		assert.equal(existsSync(zipPath), true, `${zipPath} should exist`);
		assert.deepEqual(zipEntryNames(zipPath), Object.keys(task.files).sort());
	}
});

test("community task download links sanitize unsafe href values", async () => {
	const html = await readFile(path.join(root, "index.html"), "utf8");

	assert.equal(runGeneratedSafeHref(html, "javascript:alert(1)"), "#");
	assert.equal(runGeneratedSafeHref(html, "data:text/html,<script>alert(1)</script>"), "#");
	assert.equal(runGeneratedSafeHref(html, "//evil.example/task.zip"), "#");
	assert.equal(runGeneratedSafeHref(html, "/api/submissions/12/artifact"), "/api/submissions/12/artifact");
	assert.equal(runGeneratedSafeHref(html, "https://example.com/task.zip?q=<x>&n=1"), "https://example.com/task.zip?q=&lt;x&gt;&amp;n=1");
	assert.equal(html.includes(`href="'+esc(t.downloadUrl||t.sourceUrl||'#')+'"`), false);
	assert.equal(html.includes(`href="'+safeHref(t.downloadUrl||t.sourceUrl)+'"`), true);
});

test("task share pages use the Binance-style design system", async () => {
	const pages = [
		path.join(root, "index.html"),
		path.join(root, "account", "index.html"),
		path.join(root, "upload", "index.html"),
		path.join(root, "admin", "index.html"),
		path.join(root, "tasks", "video-downloader", "index.html"),
	];

	for (const file of pages) {
		const html = await readFile(file, "utf8");
		assert.match(html, /data-design="binance"/);
		assert.match(html, /--canvas:#0b0e11/);
		assert.match(html, /--yellow:#fcd535/);
		assert.match(html, /BinancePlex/);
		assert.doesNotMatch(html, /linear-gradient|glass|blur\(|orb|bokeh/i);
	}

	assert.match(await readFile(path.join(root, "upload", "index.html"), "utf8"), /data-surface="transactional"/);
	assert.match(await readFile(path.join(root, "admin", "index.html"), "utf8"), /data-surface="transactional"/);
});
