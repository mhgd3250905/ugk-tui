import test from "node:test";
import assert from "node:assert/strict";
import { getDeepSeekStatus } from "../extensions/deepseek-status.ts";

test("exposes a structured BOM-safe DeepSeek auth state", async () => {
	const module = await import("../extensions/deepseek-status.ts");
	assert.equal(typeof (module as any).getDeepSeekAuthState, "function");
	const getState = (module as any).getDeepSeekAuthState;

	assert.deepEqual(getState({ env: { DEEPSEEK_API_KEY: "sk-env" } }), {
		configured: true,
		provider: "deepseek",
		source: "env",
	});
	assert.deepEqual(getState({ env: {}, authPath: "auth.json", readFile: () => `\uFEFF${JSON.stringify({ deepseek: { type: "api_key", key: "sk-file" } })}` }), {
		configured: true,
		provider: "deepseek",
		source: "auth_json",
	});
	for (const readFile of [() => { throw new Error("missing"); }, () => "{bad json"]) {
		assert.deepEqual(getState({ env: {}, authPath: "auth.json", readFile }), {
			configured: false,
			provider: "deepseek",
			source: null,
		});
	}
});

test("reports configured when DeepSeek API key exists in environment", () => {
	assert.equal(
		getDeepSeekStatus({
			env: { DEEPSEEK_API_KEY: "sk-test" },
			readFile: () => {
				throw new Error("auth should not be read when env is set");
			},
		}),
		"deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)",
	);
});

test("reports configured when pi login stored DeepSeek auth", () => {
	assert.equal(
		getDeepSeekStatus({
			env: {},
			authPath: "C:\\Users\\me\\.pi\\agent\\auth.json",
			readFile: () => JSON.stringify({ deepseek: { apiKey: "sk-login" } }),
		}),
		"deepseek: 已配置(pi login/auth.json, deepseek-chat/默认模型可用)",
	);
});

test("reports missing when neither environment nor pi auth has DeepSeek", () => {
	assert.equal(
		getDeepSeekStatus({
			env: {},
			authPath: "C:\\Users\\me\\.pi\\agent\\auth.json",
			readFile: () => JSON.stringify({ openai: { apiKey: "sk-openai" } }),
		}),
		"deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)",
	);
});
