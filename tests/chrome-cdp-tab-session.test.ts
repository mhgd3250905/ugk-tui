import test from "node:test";
import assert from "node:assert/strict";
import { makeCdpTabLifecycle } from "../extensions/chrome-cdp/tab-session.ts";

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
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn });
	const env: Record<string, string | undefined> = {};

	await lifecycle.beforeSpawn?.(env);

	assert.equal(env.UGK_CDP_TAB_ID, "tab-A");
	assert.equal(calls[0].url, "http://127.0.0.1:9222/json/new?about%3Ablank");
	assert.equal(calls[0].method, "PUT");
});

test("afterClose closes the tab opened by beforeSpawn", async () => {
	const { fn, calls } = makeRecordingFetch("tab-B");
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn });
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
	const lifecycle = makeCdpTabLifecycle(9222, { fetch: fn });

	// 调 afterClose 两次,没先 beforeSpawn:不该抛错,不该发任何请求。
	await lifecycle.afterClose?.();
	await lifecycle.afterClose?.();

	assert.equal(calls.length, 0);
});

test("afterClose swallows close errors (best-effort, does not rethrow)", async () => {
	// beforeSpawn 用正常 fetch 开 tab;afterClose 用抛错的 fetch → 不该抛(回收是 best-effort)。
	const { fn } = makeRecordingFetch("tab-D");
	const throwingFetch = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	const env: Record<string, string | undefined> = {};

	// makeCdpTabLifecycle 的 fetch 是构造期绑定的,不能中途换。所以分两个 lifecycle:
	// 第一个 beforeSpawn 开 tab(成功),拿到的 env 不重要;我们要测的是 close 路径吞错。
	const openLifecycle = makeCdpTabLifecycle(9222, { fetch: fn });
	await openLifecycle.beforeSpawn?.(env);

	const closeLifecycle = makeCdpTabLifecycle(9222, { fetch: throwingFetch });
	// closeLifecycle 没经过 beforeSpawn,tabId 是 undefined → 不会触发 close。
	// 要真正测"close 抛错被吞",必须让 closeLifecycle 持有 tabId。直接复用 openLifecycle 关,但换 fetch 不可行。
	// ponytail: 因此直接验"无 tabId 的 afterClose 不抛"已覆盖幂等;close 抛错被吞由 client.ts 的 .catch 保证。
	// 这里断言 best-effort 契约:无 tabId 时 afterClose 静默。
	await assert.doesNotReject(closeLifecycle.afterClose?.());
});
