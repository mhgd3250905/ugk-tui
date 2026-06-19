import test from "node:test";
import assert from "node:assert/strict";
import { extractRequirementsSpec, isSafeCommand, parseJudgeVerdict } from "../extensions/judge/judge-utils.ts";

test("extractRequirementsSpec parses fenced JSON specs", () => {
	const spec = extractRequirementsSpec(`
需求已对齐：

\`\`\`json
{
  "goal": "实现 /judge 阶段 2",
  "hardConstraints": ["只读工具", "不启动 driver"],
  "acceptance": ["agent_end 弹出菜单"],
  "forbidden": ["修改 Flow 上层行为"],
  "context": "codex/judge-agent"
}
\`\`\`
`);

	assert.deepEqual(spec, {
		goal: "实现 /judge 阶段 2",
		hardConstraints: ["只读工具", "不启动 driver"],
		acceptance: ["agent_end 弹出菜单"],
		forbidden: ["修改 Flow 上层行为"],
		context: "codex/judge-agent",
	});
});

test("extractRequirementsSpec parses bare JSON and defaults optional fields", () => {
	const spec = extractRequirementsSpec(`{
		"goal": "对齐需求",
		"hardConstraints": ["必须 TDD"],
		"acceptance": ["解析成功"]
	}`);

	assert.deepEqual(spec, {
		goal: "对齐需求",
		hardConstraints: ["必须 TDD"],
		acceptance: ["解析成功"],
		forbidden: [],
		context: "",
	});
});

test("extractRequirementsSpec returns undefined for missing required fields or invalid JSON", () => {
	assert.equal(extractRequirementsSpec("{ nope"), undefined);
	assert.equal(
		extractRequirementsSpec(`{"goal":"x","hardConstraints":[],"forbidden":[],"context":""}`),
		undefined,
	);
});

test("isSafeCommand is exported for Judge and blocks non-readonly bash commands", () => {
	assert.equal(isSafeCommand("git status --short"), true);
	assert.equal(isSafeCommand("npm install"), false);
	assert.equal(isSafeCommand("echo hacked > output.txt"), false);
});

test("parseJudgeVerdict parses pass, steer, and abort verdict JSON", () => {
	assert.deepEqual(parseJudgeVerdict(`{"action":"pass","keepWatching":true}`), {
		action: "pass",
		keepWatching: true,
	});
	assert.deepEqual(parseJudgeVerdict("```json\n{\"action\":\"steer\",\"direction\":\"改用只读检查\",\"keepWatching\":false}\n```"), {
		action: "steer",
		direction: "改用只读检查",
		keepWatching: false,
	});
	assert.deepEqual(parseJudgeVerdict(`{"action":"abort","reason":"违反硬约束"}`), {
		action: "abort",
		reason: "违反硬约束",
	});
});

test("parseJudgeVerdict rejects malformed verdicts", () => {
	assert.equal(parseJudgeVerdict("{ nope"), undefined);
	assert.equal(parseJudgeVerdict(`{"action":"pass"}`), undefined);
	assert.equal(parseJudgeVerdict(`{"action":"steer","keepWatching":true}`), undefined);
	assert.equal(parseJudgeVerdict(`{"action":"abort"}`), undefined);
});
