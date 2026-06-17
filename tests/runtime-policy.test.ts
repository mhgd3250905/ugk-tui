import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyUgkRuntimePolicy } from "../bin/ugk-runtime-policy.js";

const PINNED_PI_VERSION = "0.79.4";
const PI_DEPENDENCIES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function readJson(path: string): any {
	return JSON.parse(fs.readFileSync(path, "utf8"));
}

test("package pins every pi runtime dependency to the UGK-owned version", () => {
	const pkg = readJson("package.json");

	for (const dependency of PI_DEPENDENCIES) {
		assert.equal(pkg.dependencies[dependency], PINNED_PI_VERSION);
	}
});

test("package does not include playwright as a runtime dependency", () => {
	const pkg = readJson("package.json");

	assert.equal(pkg.dependencies.playwright, undefined);
});

test("applyUgkRuntimePolicy disables pi-owned update surfaces", () => {
	const env = {
		PI_SKIP_VERSION_CHECK: "0",
		PI_TELEMETRY: "1",
	};

	applyUgkRuntimePolicy(env);

	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
});
