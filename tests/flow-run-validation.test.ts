import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFlowRunValidation, validateFlowRun } from "../extensions/flow/run-validation.ts";

function makeRun(): { taskDir: string; runDir: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "flow-run-validation-"));
	const taskDir = path.join(cwd, ".flow", "tasks", "demo-task");
	const runDir = path.join(taskDir, "runs", "run-001");
	mkdirSync(path.join(runDir, "output"), { recursive: true });
	mkdirSync(path.join(runDir, "evidence"), { recursive: true });
	writeFileSync(path.join(taskDir, "output.schema.json"), JSON.stringify({
		type: "object",
		required: ["title", "summary", "items"],
		properties: {
			title: { type: "string" },
			summary: { type: "string", maxLength: 80 },
			items: { type: "array", items: { type: "string" } },
			pathUsed: { enum: ["A", "B"] },
		},
	}, null, "\t"));
	writeFileSync(path.join(taskDir, "validator.md"), "# Validator\n");
	writeFileSync(path.join(runDir, "progress.md"), "# Progress\n\n## 结论: PASS\n");
	writeFileSync(path.join(runDir, "evidence", "read-evidence.md"), "# Evidence\n");
	return { taskDir, runDir };
}

test("validateFlowRun writes PASS validation from structured output", () => {
	const { taskDir, runDir } = makeRun();
	writeFileSync(path.join(runDir, "output", "result.json"), JSON.stringify({
		title: "ugk",
		summary: "ugk 是一个终端编码 agent。",
		items: ["npm i -g ugk-agent"],
		pathUsed: "A",
	}, null, "\t"));

	const validation = validateFlowRun({ taskId: "demo-task", runId: "run-001", taskDir, runDir, phase: "prove" });

	assert.equal(validation.result, "PASS");
	assert.equal(validation.scope, "structural");
	assert.equal(validation.summary, "ugk 是一个终端编码 agent。");
	assert.deepEqual(validation.issues, []);
	assert.equal(validation.outputPreview?.summary, "ugk 是一个终端编码 agent。");
	assert.equal(existsSync(path.join(runDir, "validation.json")), true);
	assert.match(readFileSync(path.join(runDir, "validation.md"), "utf8"), /Result: PASS/);
	assert.match(readFileSync(path.join(runDir, "validation.md"), "utf8"), /结构校验/);
	assert.match(readFileSync(path.join(runDir, "validation.md"), "utf8"), /Next step: \/flow task review demo-task\/run-001/);

	const saved = readFlowRunValidation(runDir);
	assert.equal(saved?.result, "PASS");
	assert.equal(saved?.summary, "ugk 是一个终端编码 agent。");
});

test("validateFlowRun fails when output violates schema or evidence is missing", () => {
	const { taskDir, runDir } = makeRun();
	writeFileSync(path.join(runDir, "output", "result.json"), JSON.stringify({
		title: "ugk",
		summary: "x".repeat(100),
		items: "not-array",
		pathUsed: "C",
	}, null, "\t"));
	for (const evidenceFile of ["read-evidence.md"]) {
		writeFileSync(path.join(runDir, "evidence", evidenceFile), "");
	}

	const validation = validateFlowRun({ taskId: "demo-task", runId: "run-001", taskDir, runDir, phase: "prove" });

	assert.equal(validation.result, "FAIL");
	assert.ok(validation.issues.some((issue) => issue.includes("summary")));
	assert.ok(validation.issues.some((issue) => issue.includes("items")));
	assert.ok(validation.issues.some((issue) => issue.includes("pathUsed")));
});

test("validateFlowRun returns FAIL when result output is missing", () => {
	const { taskDir, runDir } = makeRun();

	const validation = validateFlowRun({ taskId: "demo-task", runId: "run-001", taskDir, runDir, phase: "prove" });

	assert.equal(validation.result, "FAIL");
	assert.ok(validation.issues.some((issue) => issue.includes("output/result.json")));
});

test("readFlowRunValidation defaults scope to structural for legacy validation.json", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "flow-run-validation-legacy-"));
	const runDir = path.join(cwd, "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	// 旧格式:没有 scope 字段
	writeFileSync(path.join(runDir, "validation.json"), JSON.stringify({
		taskId: "demo-task",
		runId: "run-001",
		phase: "prove",
		result: "PASS",
		summary: "legacy",
		issues: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		nextStep: "/flow task review demo-task/run-001",
	}));

	const validation = readFlowRunValidation(runDir);

	assert.equal(validation?.result, "PASS");
	assert.equal(validation?.scope, "structural");
});
