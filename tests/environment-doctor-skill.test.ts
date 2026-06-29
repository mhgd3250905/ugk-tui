import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../skills/ugk-environment-doctor/scripts/set_shell_path.mjs", import.meta.url));

function findRealBash(): string | undefined {
	const candidates = process.platform === "win32"
		? [
				"E:\\Application\\Git\\bin\\bash.exe",
				"E:\\Application\\Git\\usr\\bin\\bash.exe",
				"C:\\Program Files\\Git\\bin\\bash.exe",
				"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
			]
		: ["/bin/bash", "/usr/bin/bash"];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

const realBash = findRealBash();

test("environment doctor shell helper verifies bash and writes shellPath", { skip: !realBash }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-env-doctor-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));

	const output = execFileSync(process.execPath, [scriptPath, realBash!, agentDir], { encoding: "utf8" });
	const result = JSON.parse(output);
	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));

	assert.equal(result.ok, true);
	assert.equal(result.shellPath, realBash);
	assert.equal(settings.uiLanguage, "en-US");
	assert.equal(settings.shellPath, realBash);
});

test("environment doctor shell helper refuses invalid settings JSON", { skip: !realBash }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-env-doctor-bad-json-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), "{bad");

	assert.throws(
		() => execFileSync(process.execPath, [scriptPath, realBash!, agentDir], { encoding: "utf8", stdio: "pipe" }),
		/settings\.json is not valid JSON/,
	);
});
