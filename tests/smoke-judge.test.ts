import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addDeepSeekEnvFallback, buildJudgeReport, hasJudgePass, normalizeDeepSeekApiKey } from "../scripts/smoke-judge.mjs";

test("package exposes judge smoke script", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

	assert.equal(pkg.scripts["smoke:judge"], "node scripts/smoke-judge.mjs");
});

test("judge smoke report requires Judge PASS and taskbook evidence", () => {
	const events = [
		{ msg: { type: "message_end", message: { customType: "judge-delivery", content: "✅ Judge PASS\nread package.json\njudge_complete" } } },
	];
	const report = buildJudgeReport({
		exitCode: 0,
		timedOut: false,
		stderr: "",
		events,
		taskbookRuns: [{ status: "pass" }],
	});

	assert.equal(hasJudgePass(events), true);
	assert.match(report, /Judge PASS: detected/);
	assert.match(report, /Taskbook PASS run: detected/);
	assert.match(report, /Result: pass/);
});

test("judge smoke can pass user-level DeepSeek key to child env", () => {
	assert.deepEqual(addDeepSeekEnvFallback({}, "sk-secret"), { DEEPSEEK_API_KEY: "sk-secret" });
	assert.deepEqual(addDeepSeekEnvFallback({ DEEPSEEK_API_KEY: "sk-existing" }, "sk-secret"), { DEEPSEEK_API_KEY: "sk-existing" });
});

test("judge smoke replaces malformed process DeepSeek key with user key", () => {
	assert.deepEqual(addDeepSeekEnvFallback({ DEEPSEEK_API_KEY: "DeepSeek" }, "sk-user"), { DEEPSEEK_API_KEY: "sk-user" });
	assert.deepEqual(addDeepSeekEnvFallback({ DEEPSEEK_API_KEY: "sk-existing" }, "sk-user"), { DEEPSEEK_API_KEY: "sk-existing" });
});

test("judge smoke normalizes pasted DeepSeek config text", () => {
	assert.equal(normalizeDeepSeekApiKey("DeepSeek\n\napi-key = sk-test123\nmodel_name= deepseek-v4-flash"), "sk-test123");
	assert.equal(normalizeDeepSeekApiKey("sk-raw123"), "sk-raw123");
});
