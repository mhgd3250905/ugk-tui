import test from "node:test";
import assert from "node:assert/strict";
import { checkEnv, findAdb, findScrcpy, getAdbPaths } from "../extensions/device-env.ts";

test("findAdb prefers PATH when adb version succeeds", () => {
	const adb = findAdb({
		env: {},
		exec: (command) => {
			assert.equal(command, "adb version");
			return "";
		},
		exists: () => false,
	});

	assert.equal(adb, "adb");
});

test("findScrcpy falls back to known install directories", () => {
	const scrcpy = findScrcpy({
		env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
		exec: () => {
			throw new Error("not on PATH");
		},
		exists: (candidate) => candidate.endsWith("scrcpy.exe"),
	});

	assert.match(scrcpy ?? "", /scrcpy\.exe$/);
});

test("getAdbPaths does not return duplicate candidates", () => {
	const paths = getAdbPaths({});

	assert.equal(new Set(paths).size, paths.length);
});

test("checkEnv reports missing adb and scrcpy install commands", () => {
	const output = checkEnv({
		env: {},
		exec: () => {
			throw new Error("missing");
		},
		exists: () => false,
	});

	assert.match(output, /adb\s+未找到/);
	assert.match(output, /scrcpy\s+未找到/);
	assert.match(output, /winget install Google\.PlatformTools/);
	assert.match(output, /winget install Genymobile\.scrcpy/);
});
