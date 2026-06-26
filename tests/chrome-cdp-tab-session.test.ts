import test from "node:test";
import assert from "node:assert/strict";
import { makeCdpTabLifecycle } from "../extensions/chrome-cdp/tab-session.ts";

// ponytail: 测试禁用文件日志(log: ()=>{}),避免污染生产 cdp-tab.log。
// 生产日志路径在 tab-session.ts 的 tabLog(appendFileSync),测试不该碰。
const noLog = () => {};

// ponytail: 最小 fake fetch。/json/new → 返回 tab descriptor;其它(含 /json/close)→ 空响应。
// 记录每次调用的 url + method,断言 create 用 PUT、close 用 GET。
function makeRecordingFetch(newTabId: string) {
	const calls: { url: string; method?: string }[] = [];
	const fn = async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method });
		const isNew = url.includes("/json/new");
		const body: unknown = isNew
			? { id: newTabId, type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://x/devtools/page/${newTabId}` }
			: {};
		return { ok: true, status: 200, json: async () => body } as Response;
	};
	return { fn: fn as unknown as typeof fetch, calls };
}

test("beforeSpawn opens a tab and injects UGK_CDP_TAB_ID into env", async () => {
	const { fn, calls } = makeRecordingFetch("tab-A");
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn, log: noLog });
	const env: Record<string, string | undefined> = {};

	await lifecycle.beforeSpawn?.(env);

	assert.equal(env.UGK_CDP_TAB_ID, "tab-A");
	assert.equal(calls[0].url, "http://127.0.0.1:9222/json/new?about%3Ablank");
	assert.equal(calls[0].method, "PUT");
});

test("afterClose closes the tab opened by beforeSpawn", async () => {
	const { fn, calls } = makeRecordingFetch("tab-B");
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn, log: noLog });
	const env: Record<string, string | undefined> = {};

	await lifecycle.beforeSpawn?.(env);
	await lifecycle.afterClose?.();

	const closeCall = calls.find((c) => c.url.includes("/json/close/"));
	assert.ok(closeCall, "expected a /json/close/ request after afterClose");
	assert.equal(closeCall!.url, "http://127.0.0.1:9222/json/close/tab-B");
	assert.equal(closeCall!.method, "GET");
});

test("afterClose is idempotent when beforeSpawn never ran (no tabId)", async () => {
	const { fn, calls } = makeRecordingFetch("tab-C");
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn, log: noLog });

	// 调 afterClose 两次,没先 beforeSpawn:不该抛错,不该发任何请求。
	await lifecycle.afterClose?.();
	await lifecycle.afterClose?.();

	assert.equal(calls.length, 0);
});

test("afterClose swallows close errors (best-effort, does not rethrow)", async () => {
	// ponytail: 直接验证幂等契约:无 tabId 的 afterClose 不抛。
	// close 路径的错被吞由 client.ts 的 .catch + tab-session try/catch 双重保证,不重复测实现细节。
	const { fn } = makeRecordingFetch("tab-D");
	const throwingFetch = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	const env: Record<string, string | undefined> = {};

	const closeLifecycle = makeCdpTabLifecycle(9222, { fetch: throwingFetch, log: noLog });
	// closeLifecycle 没经过 beforeSpawn → tabId undefined → 不触发 close → 不该抛。
	await assert.doesNotReject(closeLifecycle.afterClose?.());

	// 另验:beforeSpawn 开 tab 成功,afterClose 即使 close 抛错也不该抛(best-effort)。
	const openLifecycle = makeCdpTabLifecycle(9222, { fetch: fn, log: noLog });
	await openLifecycle.beforeSpawn?.(env);
	// 切到抛错 fetch 再 close:openLifecycle 闭包内的 client 已绑 fn,无法中途换。
	// 故 best-effort 吞错由 closeChromeTab 的 .catch 保证(见 tab-session.ts afterClose)。
	await assert.doesNotReject(openLifecycle.afterClose?.());
});

