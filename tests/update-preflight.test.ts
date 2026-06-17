import test from "node:test";
import assert from "node:assert/strict";
import {
	formatCliUpdatePrompt,
	runUgkUpdatePreflight,
	shouldRunCliUpdatePreflight,
	type CliUpdateChoice,
} from "../bin/update-preflight.js";
import type { UgkUpdateState } from "../extensions/update-check.ts";

const CURRENT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LATEST = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ttyStream(isTTY = true) {
	let text = "";
	return {
		isTTY,
		write(chunk: string) {
			text += chunk;
		},
		text: () => text,
	};
}

test("shouldRunCliUpdatePreflight only runs for interactive startup", () => {
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
	assert.equal(
		shouldRunCliUpdatePreflight({ argv: ["--print", "hello"], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }),
		false,
	);
	assert.equal(
		shouldRunCliUpdatePreflight({ argv: ["--version"], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }),
		false,
	);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: { UGK_SKIP_UPDATE_CHECK: "1" }, stdin: { isTTY: true }, stdout: { isTTY: true } }), false);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
});

test("formatCliUpdatePrompt mirrors codex-style numbered update choices", () => {
	const prompt = formatCliUpdatePrompt(
		{
			currentRef: CURRENT,
			latestRef: LATEST,
			currentVersion: "1.0.0",
			source: "github-main",
		},
		"npm install -g ugk-agent",
	);

	assert.match(prompt, /✨ Update available!/);
	assert.match(prompt, /1\.0\.0 \(aaaaaaa\) -> bbbbbbb/);
	assert.match(prompt, /1\. Update now \(runs `npm install -g ugk-agent`\)/);
	assert.match(prompt, /2\. Skip/);
	assert.match(prompt, /3\. Skip until next version/);
});

test("runUgkUpdatePreflight continues when no update is available", async () => {
	const output = ttyStream();
	let applied = false;
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		readState: () => ({}),
		writeState: () => {},
		detectUpdate: async () => undefined,
		applyUpdate: async () => {
			applied = true;
			return "must not update";
		},
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(applied, false);
	assert.equal(output.text(), "");
});

test("runUgkUpdatePreflight skip only affects the current run", async () => {
	const output = ttyStream();
	let state: UgkUpdateState = {};
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "skip",
		applyUpdate: async () => "must not update",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(state.skippedRef, undefined);
	assert.equal(state.skippedAt, undefined);
	assert.match(output.text(), /Skipping this UGK update for now/);
});

test("runUgkUpdatePreflight skip until next version records the latest ref", async () => {
	let state: UgkUpdateState = {};
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: ttyStream() as any,
		stderr: ttyStream() as any,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "skip-until-next",
		applyUpdate: async () => "must not update",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(state.skippedRef, LATEST);
	assert.equal(state.skippedAt, "2026-06-17T00:00:00.000Z");
});

test("runUgkUpdatePreflight updates and asks caller to exit before pi starts", async () => {
	const output = ttyStream();
	let applied = false;
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		readState: () => ({}),
		writeState: () => {},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "update",
		applyUpdate: async () => {
			applied = true;
			return "done";
		},
		updateCommandLabel: () => "npm install -g ugk-agent",
	});

	assert.deepEqual(result, { action: "exit", exitCode: 0 });
	assert.equal(applied, true);
	assert.match(output.text(), /Updating UGK via `npm install -g ugk-agent`/);
	assert.match(output.text(), /🎉 Update ran successfully! Please restart UGK\./);
});

