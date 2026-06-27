import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	captureChromeScreenshot,
	closeChromeTab,
	createChromeCdpClient,
	createChromeTab,
	evaluateChromeExpression,
	listChromeTabs,
	navigateChromeTab,
} from "../extensions/chrome-cdp/client.ts";
import { formatChromeCdpStatus, formatChromeTabs } from "../extensions/chrome-cdp/formatter.ts";

const sampleTabs = [
	{
		id: "tab-1",
		type: "page",
		title: "Dashboard",
		url: "https://private.example.com/dashboard",
		webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab-1",
	},
	{
		id: "worker-1",
		type: "service_worker",
		title: "Worker",
		url: "https://private.example.com/sw.js",
	},
];

function makeFetch(response: unknown, ok = true) {
	return async () =>
		({
			ok,
			status: ok ? 200 : 500,
			json: async () => response,
		}) as Response;
}

class FakeWebSocket {
	static sent: string[] = [];
	static response: unknown = { id: 1, result: {} };
	readonly url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		queueMicrotask(() => this.onopen?.());
	}

	send(message: string) {
		FakeWebSocket.sent.push(message);
		queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(FakeWebSocket.response) }));
	}

	close() {
		this.onclose?.();
	}
}

test("listChromeTabs returns only page targets from local CDP", async () => {
	const client = createChromeCdpClient({
		port: 9222,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});

	const tabs = await listChromeTabs(client);

	assert.deepEqual(tabs, [sampleTabs[0]]);
});

test("formatChromeTabs summarizes useful tab details", () => {
	const output = formatChromeTabs([sampleTabs[0]]);

	assert.match(output, /^🌐 Chrome tabs/);
	assert.match(output, /┌─+┬─+┬─+┬─+┐/);
	assert.match(output, /│\s*#\s*│\s*ID\s*│\s*Title\s*│\s*URL\s*│/);
	assert.match(output, /│\s*1\s*│\s*tab-1\s*│\s*Dashboard\s*│\s*https:\/\/private\.example\.com\/dashboard\s*│/);
});

test("formatChromeCdpStatus reports online and offline states", () => {
	assert.match(formatChromeCdpStatus({ online: true, port: 9222, tabs: [sampleTabs[0]] }), /│\s*✅\s*│\s*127\.0\.0\.1:9222\s*│\s*online\s*│\s*1\s*│/);
	assert.match(formatChromeCdpStatus({ online: false, port: 9444, error: "ECONNREFUSED" }), /│\s*⚠️\s*│\s*127\.0\.0\.1:9444\s*│\s*not reachable\s*│\s*0\s*│/);
	assert.match(formatChromeCdpStatus({ online: false, port: 9444, error: "ECONNREFUSED" }), /│\s*↳\s*│\s*error\s*│\s*ECONNREFUSED\s*│/);
});

test("navigateChromeTab sends Page.navigate to the matched tab", async () => {
	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { frameId: "frame-1" } };
	const client = createChromeCdpClient({
		port: 9222,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});

	const result = await navigateChromeTab(client, "tab-1", "https://private.example.com/settings");

	assert.equal(result.frameId, "frame-1");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Page.navigate",
		params: { url: "https://private.example.com/settings" },
	});
});

test("evaluateChromeExpression sends Runtime.evaluate and returns value", async () => {
	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { result: { type: "string", value: "ok" } } };
	const client = createChromeCdpClient({
		port: 9222,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});

	const result = await evaluateChromeExpression(client, "tab-1", "document.title");

	assert.equal(result.value, "ok");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Runtime.evaluate",
		params: { expression: "document.title", returnByValue: true, awaitPromise: true },
	});
});

// ponytail: timeoutMs 透传 + 钳位验证。client.ts 钳位到 1s~5min:
// 防负数/0 立即触发(下限),防 LLM 传天文数字挂起(上限)。用永不响应的 fake 模拟卡死。
class SilentWebSocket {
	readonly url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(url: string) {
		this.url = url;
		queueMicrotask(() => this.onopen?.());
	}
	send() { /* 故意不响应,触发超时 */ }
	close() { this.onclose?.(); }
}

test("evaluateChromeExpression timeoutMs 透传且钳位到 1s~5min", async () => {
	const client = createChromeCdpClient({
		port: 9222,
		fetch: makeFetch(sampleTabs),
		WebSocket: SilentWebSocket as any,
	});

	// 传合法值 1100ms:应在该值附近超时(证明透传,而非默认 10s,也没被异常钳到下限)
	const start = Date.now();
	await assert.rejects(
		evaluateChromeExpression(client, "tab-1", "loop", 1100),
		/Timed out waiting for CDP response/,
	);
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 1000 && elapsed < 3000, `1100ms 应在 1~3s 超时,实际 ${elapsed}ms`);
});

test("captureChromeScreenshot writes screenshot bytes to disk", async () => {
	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { data: Buffer.from("png").toString("base64") } };
	const client = createChromeCdpClient({
		port: 9222,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});
	const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ugk-cdp-")), "shot.png");

	const result = await captureChromeScreenshot(client, "tab-1", filePath);

	assert.equal(result.path, filePath);
	assert.equal(fs.readFileSync(filePath, "utf8"), "png");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Page.captureScreenshot",
		params: { format: "png", fromSurface: true },
	});
});

// ponytail: 记录 URL + method 的 fetch,用于断言 createChromeTab/closeChromeTab 的 HTTP 契约。
function recordingFetch(response: unknown, ok = true) {
	const calls: { url: string; method?: string }[] = [];
	const fn = async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method });
		return { ok, status: ok ? 200 : 500, json: async () => response } as Response;
	};
	return { fn, calls };
}

test("createChromeTab PUTs /json/new with url and returns the new tab descriptor", async () => {
	const newTab = { id: "tab-new", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://x/devtools/page/tab-new" };
	const { fn, calls } = recordingFetch(newTab);
	const client = createChromeCdpClient({ port: 9222, fetch: fn as any, WebSocket: FakeWebSocket as any });

	const tab = await createChromeTab(client, "about:blank");

	assert.equal(tab.id, "tab-new");
	assert.equal(calls[0].url, "http://127.0.0.1:9222/json/new?about%3Ablank");
	assert.equal(calls[0].method, "PUT");
});

test("createChromeTab PUTs /json/new without url when none given", async () => {
	const newTab = { id: "tab-new", type: "page", url: "", webSocketDebuggerUrl: "ws://x/devtools/page/tab-new" };
	const { fn, calls } = recordingFetch(newTab);
	const client = createChromeCdpClient({ port: 9222, fetch: fn as any, WebSocket: FakeWebSocket as any });

	await createChromeTab(client);

	assert.equal(calls[0].url, "http://127.0.0.1:9222/json/new");
});

test("createChromeTab throws on non-ok HTTP status", async () => {
	const client = createChromeCdpClient({ port: 9222, fetch: makeFetch({}, false), WebSocket: FakeWebSocket as any });

	await assert.rejects(createChromeTab(client), /HTTP 500/);
});

test("closeChromeTab GETs /json/close/<id> without throwing", async () => {
	const { fn, calls } = recordingFetch({});
	const client = createChromeCdpClient({ port: 9222, fetch: fn as any, WebSocket: FakeWebSocket as any });

	await closeChromeTab(client, "tab-xyz");

	assert.equal(calls[0].url, "http://127.0.0.1:9222/json/close/tab-xyz");
	assert.equal(calls[0].method, "GET");
});
