import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

test("task share manifest describes official taskbooks with matching local files", async () => {
	const manifest = await readJson(path.join(root, "manifest.json"));

	assert.equal(manifest.version, 1);
	assert.ok(Array.isArray(manifest.tasks));
	assert.ok(manifest.tasks.length >= 11);
	assert.ok(manifest.tasks.some((task) => Object.keys(task.files).some((file) => file.startsWith("scripts/"))));

	for (const task of manifest.tasks) {
		assert.match(task.name, /^[A-Za-z0-9_-]+$/);
		assert.equal(task.install, `ugk task install ${task.name}`);
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
		assert.doesNotMatch(detail, />Like<\/button>/);
		assert.doesNotMatch(detail, />Favorite<\/button>/);

		const zipPath = path.join(root, "downloads", `${task.name}.zip`);
		assert.equal(existsSync(zipPath), true, `${zipPath} should exist`);
		assert.deepEqual(zipEntryNames(zipPath), Object.keys(task.files).sort());
	}
});
