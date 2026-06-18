import test from "node:test";
import assert from "node:assert/strict";
import {
	canonicalJson,
	CORRUPT_FEEDBACK,
	deriveProjectKey,
	getOrCreateMasterKey,
	signRecord,
	verifyRecord,
} from "../extensions/flow/flow-signing.ts";

// ---- canonicalJson 确定性 ----

test("canonicalJson is field-order independent", () => {
	assert.equal(
		canonicalJson({ status: "ready", id: "x", version: 1 }),
		canonicalJson({ version: 1, id: "x", status: "ready" }),
	);
});

test("canonicalJson differs when content differs", () => {
	assert.notEqual(
		canonicalJson({ status: "ready" }),
		canonicalJson({ status: "draft" }),
	);
});

test("canonicalJson sorts nested object keys recursively", () => {
	assert.equal(
		canonicalJson({ outer: { b: 2, a: 1 } }),
		'{"outer":{"a":1,"b":2}}',
	);
});

test("canonicalJson preserves array order (arrays are ordered)", () => {
	assert.notEqual(
		canonicalJson([1, 2, 3]),
		canonicalJson([3, 2, 1]),
	);
	assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
});

test("canonicalJson is deterministic for NaN and null edge cases", () => {
	// JSON.stringify(NaN) = "null",确定
	assert.equal(canonicalJson({ x: NaN }), canonicalJson({ x: null }));
	// null 稳定
	assert.equal(canonicalJson(null), "null");
});

// ---- 密钥派生 ----

test("deriveProjectKey is deterministic for same cwd", () => {
	const master = getOrCreateMasterKey();
	const k1 = deriveProjectKey({ cwd: "/proj/x" }, master);
	const k2 = deriveProjectKey({ cwd: "/proj/x" }, master);
	assert.ok(k1.equals(k2));
});

test("deriveProjectKey differs across cwds", () => {
	const master = getOrCreateMasterKey();
	const k1 = deriveProjectKey({ cwd: "/proj/a" }, master);
	const k2 = deriveProjectKey({ cwd: "/proj/b" }, master);
	assert.ok(!k1.equals(k2));
});

// ---- 签名与验签 ----

const TASK_COVERED = ["id", "status", "version", "latest_review_run", "ready_origin"];

test("verifyRecord accepts a legitimately signed record", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", version: 1, latest_review_run: "run-001" };
	const sig = signRecord(key, record, TASK_COVERED);
	const withSig = { ...record, _sig: sig };
	assert.equal(verifyRecord(key, withSig).verified, true);
});

test("verifyRecord rejects a tampered status (core protection)", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "needs-work", version: 1 };
	const sig = signRecord(key, record, TASK_COVERED);
	// agent 篡改 status 但保留旧 _sig
	const tampered = { id: "t1", status: "ready", version: 1, _sig: sig };
	const result = verifyRecord(key, tampered);
	assert.equal(result.verified, false);
	assert.equal((result as { reason: string }).reason, "mismatch");
});

test("verifyRecord rejects a record with no signature", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", version: 1 };
	const result = verifyRecord(key, record);
	assert.equal(result.verified, false);
	assert.equal((result as { reason: string }).reason, "no-signature");
});

test("verifyRecord rejects a malformed _sig block", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", _sig: { not: "valid" } };
	const result = verifyRecord(key, record);
	assert.equal(result.verified, false);
	assert.equal((result as { reason: string }).reason, "malformed");
});

test("signing covers exactly the listed fields (extra fields ignored)", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", version: 1, goal: "翻译", tags: ["a"] };
	const sig = signRecord(key, record, TASK_COVERED);
	const withSig = { ...record, _sig: sig };
	// goal/tags 不在 covered 里,改动它们不影响签名——这些是 agent 可自由写的字段
	assert.equal(verifyRecord(key, withSig).verified, true);
	const modifiedGoal = { ...withSig, goal: "改了目标" };
	assert.equal(verifyRecord(key, modifiedGoal).verified, true);
});

test("a signed record verified with a different project key fails", () => {
	const keyA = deriveProjectKey({ cwd: "/proj-a" }, getOrCreateMasterKey());
	const keyB = deriveProjectKey({ cwd: "/proj-b" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", version: 1 };
	const sig = signRecord(keyA, record, TASK_COVERED);
	const withSig = { ...record, _sig: sig };
	assert.equal(verifyRecord(keyB, withSig).verified, false);
});

test("covered field deletion is detected (missing signed field)", () => {
	const key = deriveProjectKey({ cwd: "/test" }, getOrCreateMasterKey());
	const record = { id: "t1", status: "ready", version: 1, latest_review_run: "run-001" };
	const sig = signRecord(key, record, TASK_COVERED);
	// 删掉 latest_review_run(它在 covered 里)
	const deleted = { id: "t1", status: "ready", version: 1, _sig: sig };
	const result = verifyRecord(key, deleted);
	assert.equal(result.verified, false);
});

// ---- 反馈文案安全(不泄露签名机制) ----

test("CORRUPT_FEEDBACK messages contain no signing/key terms", () => {
	const banned = ["签名", "密钥", "HMAC", "_sig", "signature", "key", "hmac"];
	const messages = [
		CORRUPT_FEEDBACK.taskStatus("demo-task"),
		CORRUPT_FEEDBACK.review("demo-task"),
		CORRUPT_FEEDBACK.validation("run-001"),
	];
	for (const msg of messages) {
		for (const term of banned) {
			assert.ok(!msg.includes(term), `反馈 "${msg}" 泄露了禁词: ${term}`);
		}
	}
});

test("CORRUPT_FEEDBACK gives a safe recovery action, not destructive", () => {
	const taskMsg = CORRUPT_FEEDBACK.taskStatus("demo-task");
	// 给的是"重新 prove",不是"删除"或"手动修复"
	assert.match(taskMsg, /重新开始|\/flow task prove/);
	assert.ok(!taskMsg.includes("删除"));
	assert.ok(!taskMsg.includes("手动修复"));
});
