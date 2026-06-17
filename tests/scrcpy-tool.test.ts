import test from "node:test";
import assert from "node:assert/strict";
import { formatScrcpyStatus, formatScrcpyVersion, splitExtraArgs } from "../extensions/scrcpy-tool.ts";

test("splitExtraArgs preserves existing whitespace-based argument parsing", () => {
	assert.deepEqual(splitExtraArgs(undefined), []);
	assert.deepEqual(splitExtraArgs(""), []);
	assert.deepEqual(splitExtraArgs(" --max-size 1280  --max-fps 30 "), ["--max-size", "1280", "--max-fps", "30"]);
});

test("scrcpy query formatters render status tables", () => {
	assert.match(formatScrcpyStatus(true), /^📱 scrcpy status/);
	assert.match(formatScrcpyStatus(true), /│\s*进程\s*│\s*✅ 正在运行\s*│/);
	assert.match(formatScrcpyStatus(false), /│\s*进程\s*│\s*⏸️ 未在运行\s*│/);
	assert.match(formatScrcpyStatus(false, true), /│\s*进程\s*│\s*❌ 无法查询状态\s*│/);

	const version = formatScrcpyVersion("scrcpy 4.0", "E:\\platform-tools\\adb.exe");
	assert.match(version, /^📱 scrcpy version/);
	assert.match(version, /│\s*scrcpy\s*│\s*✅ scrcpy 4\.0\s*│/);
	assert.match(version, /│\s*ADB\s*│\s*E:\\platform-tools\\adb\.exe\s*│/);
});
