import test from "node:test";
import assert from "node:assert/strict";
import { splitExtraArgs } from "../extensions/scrcpy-tool.ts";

test("splitExtraArgs preserves existing whitespace-based argument parsing", () => {
	assert.deepEqual(splitExtraArgs(undefined), []);
	assert.deepEqual(splitExtraArgs(""), []);
	assert.deepEqual(splitExtraArgs(" --max-size 1280  --max-fps 30 "), ["--max-size", "1280", "--max-fps", "30"]);
});
