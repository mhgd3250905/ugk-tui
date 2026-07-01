import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { buildTaskZip, publishTask } from "../extensions/task/task-share-publish.ts";
import type { LoadedTaskbook } from "../extensions/task/task-book.ts";

function sampleLoaded(name = "demo-task", withRuns = true): LoadedTaskbook {
	return {
		taskbook: {
			name,
			description: "a demo task",
			scope: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			tags: ["demo"],
			runs: withRuns ? [
				// runs must be stripped before upload (doc §6.5 + §10 risk②)
				{ timestamp: "2026-01-02T00:00:00.000Z", status: "pass", exitCode: 0, verifyFailures: [], duration: 1.2, input: "x" } as any,
				{ timestamp: "2026-01-03T00:00:00.000Z", status: "fail", exitCode: 1, verifyFailures: [], duration: 0.4, input: "y" } as any,
			] : [],
		},
		spec: { goal: "do demo", hardConstraints: ["works"], acceptance: ["passes"] } as any,
		contract: { runtimeInput: ["url"] },
		skill: "# Demo\nWrite result.\n",
		verify: "process.exit(0);\n",
		scope: "user",
		dir: "/fake/agent/tasks/demo-task",
	};
}

test("buildTaskZip contains the 5 required files", () => {
	const zip = buildTaskZip(sampleLoaded());
	const entries = Object.keys(unzipSync(zip));
	for (const file of ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"]) {
		assert.ok(entries.includes(file), `missing ${file}`);
	}
});

test("buildTaskZip strips the runs history from taskbook.json", () => {
	const zip = buildTaskZip(sampleLoaded("demo-task", true));
	const files = unzipSync(zip);
	const taskbook = JSON.parse(new TextDecoder().decode(files["taskbook.json"]));
	assert.deepEqual(taskbook.runs, []);
	// other fields preserved
	assert.equal(taskbook.name, "demo-task");
	assert.equal(taskbook.description, "a demo task");
});

test("buildTaskZip does not mutate the source LoadedTaskbook", () => {
	const loaded = sampleLoaded("demo-task", true);
	buildTaskZip(loaded);
	assert.equal(loaded.taskbook.runs.length, 2, "original runs array untouched");
});

test("publishTask sends multipart with name/version/artifact and Bearer token", async () => {
	let captured: { url: string; headers: Headers; form: FormData } | null = null;
	const fetchFn = async (url: string, init: any) => {
		captured = { url, headers: new Headers(init.headers), form: init.body as FormData };
		return new Response(JSON.stringify({ status: "pending", name: "demo-task", version: "1.0.0" }), { headers: { "content-type": "application/json" } });
	};

	const result = await publishTask(sampleLoaded(), "1.0.0", "TOKEN", "https://m.test", undefined, undefined, { fetchFn });

	assert.equal(result.ok, true);
	assert.equal(result.name, "demo-task");
	assert.equal(result.version, "1.0.0");
	assert.match(captured!.url, /\/api\/tasks\/submit$/);
	assert.equal(captured!.headers.get("authorization"), "Bearer TOKEN");
	assert.equal(captured!.form.get("name"), "demo-task");
	assert.equal(captured!.form.get("version"), "1.0.0");
	assert.equal(captured!.form.get("title"), "demo-task"); // defaults to name when no custom title
	assert.equal(captured!.form.get("description"), "a demo task"); // description falls back to taskbook.description
	const artifact = captured!.form.get("artifact") as File;
	assert.equal(artifact.type, "application/zip");
	assert.match(artifact.name, /demo-task-1\.0\.0\.zip$/);
});

test("publishTask uses an explicit title when provided", async () => {
	let captured: FormData | null = null;
	const fetchFn = async (_url: string, init: any) => {
		captured = init.body as FormData;
		return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } });
	};
	await publishTask(sampleLoaded(), "2.0.0", "T", "https://m.test", "Custom Title", undefined, { fetchFn });
	assert.equal(captured!.get("title"), "Custom Title");
});

test("publishTask uses an explicit description when provided (separate from title)", async () => {
	// title and description are distinct fields; a custom short description must
	// override the long agent-facing taskbook.description.
	let captured: FormData | null = null;
	const fetchFn = async (_url: string, init: any) => {
		captured = init.body as FormData;
		return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } });
	};
	await publishTask(sampleLoaded(), "3.0.0", "T", "https://m.test", "Short Title", "One-line summary for the card", { fetchFn });
	assert.equal(captured!.get("title"), "Short Title");
	assert.equal(captured!.get("description"), "One-line summary for the card");
});

test("publishTask throws with the server error detail on failure", async () => {
	const fetchFn = async () => new Response(JSON.stringify({ error: "invalid_version" }), { status: 400, headers: { "content-type": "application/json" } });
	await assert.rejects(
		() => publishTask(sampleLoaded(), "bad", "T", "https://m.test", undefined, undefined, { fetchFn }),
		/invalid_version/,
	);
});
