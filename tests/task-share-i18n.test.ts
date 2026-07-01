import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function loadI18n(search = "") {
	const stored: Record<string, string> = {};
	let href = "http://example.test/" + search;
	const context = {
		window: {
			location: { search, href },
			history: {
				replaceState: (_state: unknown, _title: string, url: URL) => {
					href = String(url);
					context.window.location.href = href;
					context.window.location.search = url.search;
				},
			},
			addEventListener() {},
			dispatchEvent() {},
		},
		document: {
			documentElement: { lang: "" },
			readyState: "complete",
			querySelectorAll: () => [],
			addEventListener() {},
		},
		localStorage: {
			getItem: (key: string) => stored[key] || "",
			setItem: (key: string, value: string) => { stored[key] = value; },
		},
		navigator: { languages: ["en-US"], language: "en-US" },
		CustomEvent: class CustomEvent {
			type: string;
			init: unknown;
			constructor(type: string, init: unknown) {
				this.type = type;
				this.init = init;
			}
		},
		URL,
		URLSearchParams,
	};
	vm.runInNewContext(readFileSync("docs/task-share/i18n.js", "utf8"), context);
	return context;
}

test("task-share i18n switches supported languages", () => {
	const context = loadI18n("?lang=zh-CN");
	const i18n = context.window.UGKI18N;
	assert.equal(i18n.lang, "zh-CN");
	assert.equal(i18n.t("nav.signIn"), "登录");
	i18n.setLang("ja");
	assert.equal(i18n.lang, "ja");
	assert.equal(i18n.t("nav.signIn"), "ログイン");
	assert.match(context.window.location.search, /lang=ja/);
});

test("task-share i18n locale keys stay complete", () => {
	const { window } = loadI18n();
	const messages = window.UGKI18N.messages;
	const expected = Object.keys(messages.en).sort();
	for (const [lang, table] of Object.entries(messages)) {
		assert.deepEqual(Object.keys(table as Record<string, string>).sort(), expected, lang);
	}
});
