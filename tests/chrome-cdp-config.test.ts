import test from "node:test";
import assert from "node:assert/strict";
import {
	checkChromeCdpPolicy,
	clearChromeCdpSessionAllow,
	createChromeCdpState,
	grantChromeCdpSessionAllow,
	resolveChromeCdpPort,
	setChromeCdpMode,
	setChromeCdpPort,
} from "../extensions/chrome-cdp/config.ts";

test("createChromeCdpState defaults to ask mode and port 9222", () => {
	const state = createChromeCdpState({});

	assert.equal(state.mode, "ask");
	assert.equal(resolveChromeCdpPort(state, {}), 9222);
});

test("resolveChromeCdpPort respects explicit, runtime, env, then default priority", () => {
	const state = createChromeCdpState({ UGK_CDP_PORT: "9333" });

	assert.equal(resolveChromeCdpPort(state, { port: 9444 }), 9444);
	setChromeCdpPort(state, 9555);
	assert.equal(resolveChromeCdpPort(state, {}), 9555);

	const envOnly = createChromeCdpState({ UGK_CDP_PORT: "9333" });
	assert.equal(resolveChromeCdpPort(envOnly, {}), 9333);

	const invalidEnv = createChromeCdpState({ UGK_CDP_PORT: "nope" });
	assert.equal(resolveChromeCdpPort(invalidEnv, {}), 9222);
});

test("setChromeCdpPort rejects invalid ports", () => {
	const state = createChromeCdpState({});

	assert.throws(() => setChromeCdpPort(state, 0), /Invalid CDP port/);
	assert.throws(() => setChromeCdpPort(state, 70000), /Invalid CDP port/);
	assert.throws(() => setChromeCdpPort(state, 1.5), /Invalid CDP port/);
});

test("checkChromeCdpPolicy blocks execution when mode is off", () => {
	const state = createChromeCdpState({});
	setChromeCdpMode(state, "off");

	const result = checkChromeCdpPolicy(state, {
		action: "tabs",
		reason: "Need logged-in Chrome session",
		normalAccessAttempted: true,
	});

	assert.equal(result.allowed, false);
	assert.equal(result.requiresConfirmation, false);
	assert.match(result.reason, /off/);
});

test("checkChromeCdpPolicy allows status without confirmation", () => {
	const state = createChromeCdpState({});

	const result = checkChromeCdpPolicy(state, {
		action: "status",
		reason: "Check whether CDP is reachable",
		normalAccessAttempted: false,
	});

	assert.equal(result.allowed, true);
	assert.equal(result.requiresConfirmation, false);
});

test("checkChromeCdpPolicy blocks non-status actions when normal access was not attempted", () => {
	const state = createChromeCdpState({});

	const result = checkChromeCdpPolicy(state, {
		action: "navigate",
		url: "https://example.com",
		reason: "Open a public page",
		normalAccessAttempted: false,
	});

	assert.equal(result.allowed, false);
	assert.match(result.reason, /ordinary access/i);
});

test("checkChromeCdpPolicy requires confirmation in ask mode and allows in on mode", () => {
	const state = createChromeCdpState({});
	const request = {
		action: "navigate",
		url: "https://private.example.com",
		reason: "Requires the user's logged-in browser session",
		normalAccessAttempted: true,
	} as const;

	assert.deepEqual(checkChromeCdpPolicy(state, request), {
		allowed: true,
		requiresConfirmation: true,
	});

	setChromeCdpMode(state, "on");
	assert.deepEqual(checkChromeCdpPolicy(state, request), {
		allowed: true,
		requiresConfirmation: false,
	});
});

test("session allow skips ask confirmation until mode changes clear it", () => {
	const state = createChromeCdpState({});
	const request = {
		action: "tabs",
		reason: "Requires logged-in Chrome session",
		normalAccessAttempted: true,
	} as const;

	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, false);

	clearChromeCdpSessionAllow(state);
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	setChromeCdpMode(state, "ask");
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	setChromeCdpMode(state, "off");
	assert.equal(state.sessionAllowed, false);
});
