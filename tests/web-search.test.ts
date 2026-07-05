import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ALLOWED_HOSTS,
	buildSearchUrl,
	detectFailure,
	truncateContent,
	validateSearchUrl,
} from "../extensions/web-search/config.ts";
import {
	createWebSearchClient,
	evaluateJs,
	getWebSearchStatus,
	navigateToUrl,
} from "../extensions/web-search/client.ts";
import {
	WEB_SEARCH_DEFAULT_PORT,
	__testOnly,
	getDefaultWebSearchProfilePath,
	getWebSearchLaunchCommand,
} from "../extensions/web-search/launcher.ts";
import { doRead } from "../extensions/web-search/read.ts";
import { doSearch } from "../extensions/web-search/search.ts";
import { registerWebSearch } from "../extensions/web-search/index.ts";

const sampleSerpText = [
	"跳到主要内容",
	"搜索结果",
	"LinkedIn API",
	"https://developers.linkedin.com",
	"Build with LinkedIn APIs and services.",
	"LinkedIn Marketing API",
	"https://learn.microsoft.com/linkedin/marketing/",
	"Create campaigns and search member interests.",
].join("\n");

const sampleTabs = [
	{
		id: "tab-1",
		type: "page",
		title: "Search",
		url: "about:blank",
		webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/tab-1",
	},
	{
		id: "worker-1",
		type: "service_worker",
		title: "Worker",
		url: "https://example.com/sw.js",
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

test("web-search config builds whitelisted search URLs", () => {
	assert.equal(buildSearchUrl("LinkedIn 关键字 API", "google"), "https://www.google.com/search?q=LinkedIn%20%E5%85%B3%E9%94%AE%E5%AD%97%20API&hl=zh-CN");
	assert.equal(buildSearchUrl("LinkedIn 关键字 API", "bing"), "https://cn.bing.com/search?q=LinkedIn%20%E5%85%B3%E9%94%AE%E5%AD%97%20API&setlang=zh-CN");
	assert.deepEqual(validateSearchUrl("https://www.google.com/search?q=x"), { ok: true, host: "www.google.com" });
	assert.deepEqual(validateSearchUrl("https://evil.example/search?q=x"), { ok: false, reason: "host evil.example 不在白名单" });
	assert.equal(detectFailure("Our systems have detected unusual traffic").failed, true);
	assert.equal(detectFailure("请输入验证码").failed, true);
	assert.equal(detectFailure("This site can't be reached\nERR_CONNECTION_TIMED_OUT").failed, true);
	assert.equal(detectFailure("无法访问此网站\nERR_TUNNEL_CONNECTION_FAILED").failed, true);
	assert.deepEqual(detectFailure("正常搜索结果"), { failed: false });
});

test("detectFailure does not false-positive on normal 验证码 search results", () => {
	const normalSerp = "短信验证码 API 对比\nhttps://example.com/sms\n提供验证码短信服务,支持全球发送。";

	assert.equal(detectFailure(normalSerp).failed, false);
	assert.equal(detectFailure("请输入验证码").failed, true);
});

test("truncateContent keeps returned text under the search limit", () => {
	const result = truncateContent("a".repeat(9000), 8192);

	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 8192);
	assert.equal(result.bytes, 9000);

	const chinese = truncateContent("字".repeat(4000), 8192);
	assert.equal(chinese.truncated, true);
	assert.ok(Buffer.byteLength(chinese.text, "utf8") <= 8192);

	const tiny = truncateContent("abc", 1);
	assert.equal(tiny.truncated, true);
	assert.ok(Buffer.byteLength(tiny.text, "utf8") <= 1);
});

test("web-search client navigates and evaluateJs returns result.value", async () => {
	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { frameId: "frame-1" } };
	const client = createWebSearchClient({
		port: 9223,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});

	const nav = await navigateToUrl(client, "https://www.google.com/search?q=x");
	assert.equal(nav.frameId, "frame-1");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Page.navigate",
		params: { url: "https://www.google.com/search?q=x" },
	});

	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { result: { type: "string", value: "SERP text" } } };
	const text = await evaluateJs(client, "document.body.innerText");
	assert.equal(text, "SERP text");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Runtime.evaluate",
		params: { expression: "document.body.innerText", returnByValue: true, awaitPromise: true },
	});
});

test("getWebSearchStatus reports offline without throwing", async () => {
	const status = await getWebSearchStatus(9223, async () => {
		throw new Error("ECONNREFUSED");
	});

	assert.deepEqual(status, { online: false, port: 9223, error: "ECONNREFUSED" });
});

test("web-search launcher uses isolated headless Chrome defaults", () => {
	assert.equal(WEB_SEARCH_DEFAULT_PORT, 9223);
	assert.equal(
		getDefaultWebSearchProfilePath(path.join("/Users", "demo")),
		path.join("/Users", "demo", ".ugk", "web-search-profile"),
	);
	const command = getWebSearchLaunchCommand({ port: 9223, homeDir: path.join("/Users", "demo"), platform: "darwin" });
	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9223",
		"--remote-debugging-address=127.0.0.1",
		`--user-data-dir=${path.join("/Users", "demo", ".ugk", "web-search-profile")}`,
		"--headless=new",
		"--no-first-run",
		"--disable-gpu",
	]);
});

test("web-search launcher can build a visible Chrome command for manual debugging", () => {
	const command = getWebSearchLaunchCommand({ port: 9223, homeDir: path.join("/Users", "demo"), platform: "darwin", visible: true });

	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.ok(command.args.includes("--remote-debugging-port=9223"));
	assert.ok(command.args.includes(`--user-data-dir=${path.join("/Users", "demo", ".ugk", "web-search-profile")}`));
	assert.equal(command.args.includes("--headless=new"), false);
});

test("web-search teardown kills managed ports and clears them", () => {
	__testOnly.teardown();
	const killedPorts: number[] = [];
	const restoreKill = __testOnly.setKillImpl((port) => { killedPorts.push(port); });
	__testOnly.managedPorts.add(9223);
	__testOnly.managedPorts.add(9333);

	__testOnly.teardown();

	assert.equal(__testOnly.managedPorts.size, 0);
	assert.deepEqual(killedPorts.sort((a, b) => a - b), [9223, 9333]);
	restoreKill();
});

test("visible web-search launcher waits after killing the old port owner", async () => {
	__testOnly.teardown();
	const events: string[] = [];
	const restoreKill = __testOnly.setKillImpl((port) => { events.push(`kill:${port}`); });
	const restoreLaunch = __testOnly.setLaunchImpl((port, options) => {
		events.push(`launch:${port}:${options?.visible === true}`);
		return "Started visible web_search Chrome";
	});
	const restoreWait = __testOnly.setWaitImpl(async () => ({ ready: true, elapsedMs: 1 }));
	const restoreSleep = __testOnly.setSleepImpl(async (ms) => { events.push(`sleep:${ms}`); });

	try {
		await __testOnly.launchVisibleAndWait(9223);
		assert.deepEqual(events, ["kill:9223", "sleep:500", "launch:9223:true"]);
	} finally {
		restoreSleep();
		restoreWait();
		restoreLaunch();
		restoreKill();
	}
});

test("web-search launcher resolves Windows chrome.exe when present", () => {
	const fakeProgramFiles = path.join(os.tmpdir(), "ugk-web-search-pf");
	const chromeExe = path.join(fakeProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
	fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
	fs.writeFileSync(chromeExe, "");
	process.env.PROGRAMFILES = fakeProgramFiles;

	try {
		const command = getWebSearchLaunchCommand({ port: 9223, homeDir: os.tmpdir(), platform: "win32" });
		assert.equal(command.command, chromeExe);
		assert.ok(command.args.includes("--headless=new"));
	} finally {
		delete process.env.PROGRAMFILES;
		fs.rmSync(fakeProgramFiles, { recursive: true, force: true });
	}
});

test("doSearch launches Chrome, waits, evaluates SERP text, and returns details", async () => {
	const calls: string[] = [];
	const result = await doSearch(
		{ query: "LinkedIn API" },
		{
			status: async () => ({ online: false, port: 9223 }),
			launch: async (port) => {
				calls.push(`launch:${port}`);
				return "launched";
			},
			navigate: async (port, url) => {
				calls.push(`navigate:${port}:${url}`);
				return {};
			},
			evaluate: async (port, expr) => {
				calls.push(`evaluate:${port}`);
				assert.match(expr, /#search, #b_results/);
				return sampleSerpText;
			},
			sleep: async () => {
				calls.push("sleep");
			},
		},
	);

	assert.deepEqual(calls, [
		"launch:9223",
		"navigate:9223:https://www.google.com/search?q=LinkedIn%20API&hl=zh-CN",
		"sleep",
		"evaluate:9223",
	]);
	assert.equal(result.content[0].text, sampleSerpText);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.engine, "google");
	assert.equal(result.details.query, "LinkedIn API");
	assert.equal(result.details.normal, true);
	assert.match(result.details.summary as string, /平台: Google/);
	assert.match(result.details.summary as string, /关键词: LinkedIn API/);
	assert.match(result.details.summary as string, /状态: 成功/);
	assert.match(result.details.summary as string, /结果: 正常搜索结果/);
	assert.match(result.details.summary as string, /缩略结果:/);
	assert.match(result.details.summary as string, /1\. LinkedIn API/);
	assert.equal(result.details.fullText, sampleSerpText);
	assert.equal(result.details.fullTextTruncated, false);
	assert.equal(result.details.bytes, Buffer.byteLength(sampleSerpText, "utf8"));
	assert.deepEqual((result.details.results as any[])[0], {
		title: "LinkedIn API",
		url: "https://developers.linkedin.com",
		snippet: "Build with LinkedIn APIs and services.",
	});
});

test("doSearch falls back from Google failure to Bing CN", async () => {
	const navigated: string[] = [];
	const result = await doSearch(
		{ query: "x search" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async (_port, url) => {
				navigated.push(url);
				return {};
			},
			evaluate: async () => (navigated.length === 1 ? "Our systems have detected unusual traffic" : sampleSerpText),
			sleep: async () => {},
		},
	);

	assert.deepEqual(navigated, [
		"https://www.google.com/search?q=x%20search&hl=zh-CN",
		"https://cn.bing.com/search?q=x%20search&setlang=zh-CN",
	]);
	assert.equal(result.content[0].text, sampleSerpText);
	assert.equal(result.details.engine, "bing");
	assert.equal(result.details.ok, true);
	assert.match(result.details.summary as string, /平台: Bing/);
	assert.match(result.details.summary as string, /关键词: x search/);
	assert.match(result.details.summary as string, /状态: 成功/);
	assert.match(result.details.summary as string, /结果: 正常搜索结果/);
});

test("doSearch does not fallback when Google search URL validation fails", async () => {
	const navigated: string[] = [];
	ALLOWED_HOSTS.delete("www.google.com");
	try {
		const result = await doSearch(
			{ query: "bad url" },
			{
				status: async () => ({ online: true, port: 9223 }),
				launch: async () => "launched",
				navigate: async (_port, url) => {
					navigated.push(url);
					return {};
				},
				evaluate: async () => sampleSerpText,
				sleep: async () => {},
			},
		);

		assert.deepEqual(navigated, []);
		assert.equal(result.details.ok, false);
		assert.equal(result.details._noFallback, true);
		assert.equal(result.details.engine, "google");
	} finally {
		ALLOWED_HOSTS.add("www.google.com");
	}
});

test("doSearch retries evaluate once when navigation swaps the inspected target", async () => {
	let evaluateCalls = 0;
	const navigated: string[] = [];
	const result = await doSearch(
		{ query: "LinkedIn API" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async (_port, url) => {
				navigated.push(url);
				return {};
			},
			evaluate: async () => {
				evaluateCalls += 1;
				if (evaluateCalls === 1) throw new Error("Inspected target navigated or closed");
				return [
					"搜索结果",
					"Recovered Google result",
					"https://example.com/recovered",
					"Recovered snippet.",
				].join("\n");
			},
			sleep: async () => {},
		},
	);

	assert.deepEqual(navigated, ["https://www.google.com/search?q=LinkedIn%20API&hl=zh-CN"]);
	assert.equal(evaluateCalls, 2);
	assert.match(result.content[0].text, /Recovered Google result/);
	assert.equal(result.details.engine, "google");
	assert.match(result.details.summary as string, /平台: Google/);
	assert.match(result.details.summary as string, /1\. Recovered Google result/);
});

test("doSearch reports abnormal search pages without dumping raw SERP text", async () => {
	const blockedText = "请输入验证码\nThis page asks you to verify you are human.";
	const result = await doSearch(
		{ query: "blocked", engine: "bing" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async () => ({}),
			evaluate: async () => blockedText,
			sleep: async () => {},
		},
	);

	assert.match(result.content[0].text, /平台: Bing/);
	assert.match(result.content[0].text, /关键词: blocked/);
	assert.match(result.content[0].text, /状态: 失败/);
	assert.match(result.content[0].text, /结果: 异常页面/);
	assert.doesNotMatch(result.content[0].text, /This page asks you/);
	assert.equal(result.details.ok, false);
	assert.equal(result.details.normal, false);
	assert.equal(result.details.fullText, blockedText);
});

test("registerWebSearch registers web_search with 5-arg execute signature", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	registerWebSearch(
		{
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		} as any,
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async () => ({}),
			evaluate: async () => sampleSerpText,
			sleep: async () => {},
		},
	);

	const tool = tools.get("web_search");
	assert.ok(tool);
	assert.ok(commands.has("web-search"));
	assert.equal(tool.execute.length, 5);
	const result = await tool.execute("call-1", { query: "hello" }, undefined, undefined, { hasUI: false });
	assert.equal(result.content[0].text, sampleSerpText);
	assert.match(result.details.summary as string, /平台: Google/);
	assert.match(result.details.summary as string, /关键词: hello/);

	const stubTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text } as any;
	const collapsed = String(tool.renderResult(result, { expanded: false, isPartial: false }, stubTheme).text);
	assert.match(collapsed, /Google · 成功 · 正常/);
	assert.match(collapsed, /hello/);
	assert.match(collapsed, /1\. LinkedIn API \(developers\.linkedin\.com\)/);
	assert.match(collapsed, /2\. LinkedIn Marketing API \(learn\.microsoft\.com\)/);
	assert.match(collapsed, /Ctrl\+O to expand/);
	assert.equal(collapsed.split("\n").length, 4);
	assert.doesNotMatch(collapsed, /https:\/\/www\.google\.com/);
	assert.doesNotMatch(collapsed, /https:\/\/developers\.linkedin\.com/);
	assert.doesNotMatch(collapsed, /Build with LinkedIn APIs/);
	assert.doesNotMatch(collapsed, /跳到主要内容/);

	const expanded = String(tool.renderResult(result, { expanded: true, isPartial: false }, stubTheme).text);
	assert.match(expanded, /跳到主要内容/);
	assert.match(expanded, /Build with LinkedIn APIs/);
});

test("/web-search menu can open the isolated Chrome visibly", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const launchedPorts: number[] = [];
	registerWebSearch(
		{
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		} as any,
		{},
		{
			status: async () => ({ online: false, port: 9223, error: "offline" }),
			launchVisible: async (port) => {
				launchedPorts.push(port);
				return "visible web_search Chrome launched";
			},
		},
	);
	const selections: Array<{ title: string; options: string[] }> = [];
	const notifications: string[] = [];
	const ctx = {
		ui: {
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return "打开可见 Chrome";
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};

	await commands.get("web-search").handler("", ctx);

	assert.equal(selections[0].title, "web_search");
	assert.deepEqual(selections[0].options, ["查看状态", "打开可见 Chrome", "退出"]);
	assert.deepEqual(launchedPorts, [9223]);
	assert.match(notifications.join("\n"), /visible web_search Chrome launched/);
});

test("doRead happy path: navigate, evaluate, return cleaned text", async () => {
	const calls: string[] = [];
	const result = await doRead(
		{ url: "https://example.com/post" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => {
				calls.push("launch");
				return "launched";
			},
			navigate: async (_p, url) => {
				calls.push(`navigate:${url}`);
				return {};
			},
			evaluate: async () => {
				calls.push("evaluate");
				return JSON.stringify({ title: "Test Post", text: "正文内容".repeat(50) });
			},
			sleep: async () => {
				calls.push("sleep");
			},
		},
	);

	assert.deepEqual(calls, ["navigate:https://example.com/post", "sleep", "evaluate"]);
	assert.equal(calls.includes("launch"), false);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.url, "https://example.com/post");
	assert.equal(result.details.host, "example.com");
	assert.equal(result.details.title, "Test Post");
	assert.match(result.content[0].text, /Test Post/);
	assert.match(result.content[0].text, /https:\/\/example\.com\/post/);
	assert.match(result.content[0].text, /正文内容/);
});

test("doRead rejects non-http(s) URLs without launching Chrome", async () => {
	const calls: string[] = [];
	const result = await doRead(
		{ url: "file:///etc/passwd" },
		{
			status: async () => {
				calls.push("status");
				return { online: false, port: 9223 };
			},
			launch: async () => {
				calls.push("launch");
				return "x";
			},
			navigate: async () => {
				calls.push("navigate");
				return {};
			},
			evaluate: async () => {
				calls.push("evaluate");
				return "{}";
			},
			sleep: async () => {
				calls.push("sleep");
			},
		},
	);

	assert.deepEqual(calls, []);
	assert.equal(result.details.ok, false);
	assert.match(result.content[0].text, /仅支持 http\/https/);
});

test("doRead rejects malformed URLs", async () => {
	const result = await doRead(
		{ url: "not a url" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "x",
			navigate: async () => ({}),
			evaluate: async () => "{}",
			sleep: async () => {},
		},
	);

	assert.equal(result.details.ok, false);
	assert.match(result.content[0].text, /URL 解析失败/);
});

test("doRead retries evaluate once when navigation swaps target", async () => {
	let n = 0;
	const result = await doRead(
		{ url: "https://example.com/a" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "x",
			navigate: async () => ({}),
			evaluate: async () => {
				n += 1;
				if (n === 1) throw new Error("Inspected target navigated");
				return JSON.stringify({ title: "T", text: "正文" });
			},
			sleep: async () => {},
		},
	);

	assert.equal(n, 2);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.title, "T");
});

test("doRead launches Chrome when offline", async () => {
	const calls: string[] = [];
	await doRead(
		{ url: "https://example.com/x" },
		{
			status: async () => {
				calls.push("status");
				return { online: false, port: 9223 };
			},
			launch: async (p) => {
				calls.push(`launch:${p}`);
				return "ok";
			},
			navigate: async (_p, url) => {
				calls.push(`navigate:${url}`);
				return {};
			},
			evaluate: async () => JSON.stringify({ title: "", text: "x".repeat(300) }),
			sleep: async () => {},
		},
	);

	assert.deepEqual(calls, ["status", "launch:9223", "navigate:https://example.com/x"]);
});
