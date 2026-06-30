import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("docs", "task-share");
const requiredFiles = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];

async function readJson(filePath: string) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

test("task share manifest describes official taskbooks with matching local files", async () => {
	const manifest = await readJson(path.join(root, "manifest.json"));

	assert.equal(manifest.version, 1);
	assert.ok(Array.isArray(manifest.tasks));
	assert.ok(manifest.tasks.length > 0);

	for (const task of manifest.tasks) {
		assert.match(task.name, /^[A-Za-z0-9_-]+$/);
		assert.equal(task.install, `ugk task install ${task.name}`);
		assert.equal(task.zip, `downloads/${task.name}.zip`);
		assert.equal(typeof task.description, "string");
		assert.equal(typeof task.exampleInput, "string");
		assert.equal(typeof task.files, "object");

		const taskDir = path.join(root, "taskbooks", task.name);
		for (const file of requiredFiles) {
			const localPath = path.join(taskDir, file);
			assert.equal(existsSync(localPath), true, `${localPath} should exist`);
			assert.equal(task.files[file], `https://raw.githubusercontent.com/mhgd3250905/ugk-tui/main/docs/task-share/taskbooks/${task.name}/${file}`);
		}

		const taskbook = await readJson(path.join(taskDir, "taskbook.json"));
		const spec = await readJson(path.join(taskDir, "spec.json"));
		const contract = await readJson(path.join(taskDir, "contract.json"));
		assert.equal(taskbook.name, task.name);
		assert.equal(taskbook.scope, "user");
		assert.equal(spec.goal, task.description);
		assert.deepEqual(contract.runtimeInput, ["text"]);
	}
});

test("task share page exposes download and copy-command paths for every official task", async () => {
	const [manifest, html] = await Promise.all([
		readJson(path.join(root, "manifest.json")),
		readFile(path.join(root, "index.html"), "utf8"),
	]);

	for (const task of manifest.tasks) {
		assert.match(html, new RegExp(`ugk task install ${task.name}`));
		assert.match(html, new RegExp(`downloads/${task.name}\\.zip`));
		assert.match(html, new RegExp(task.title));

		const zipPath = path.join(root, "downloads", `${task.name}.zip`);
		assert.equal(existsSync(zipPath), true, `${zipPath} should exist`);
		assert.ok(statSync(zipPath).size > 0, `${zipPath} should not be empty`);
	}
});
