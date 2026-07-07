import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";

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
			documentElement: { lang: "", dataset: {} },
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

test("task-share theme can switch to light and persist", () => {
	const context = loadI18n();
	const i18n = context.window.UGKI18N;
	assert.equal(i18n.theme, "dark");
	assert.equal(context.document.documentElement.dataset.theme, "dark");
	i18n.setTheme("light");
	assert.equal(i18n.theme, "light");
	assert.equal(context.document.documentElement.dataset.theme, "light");
	assert.equal(context.localStorage.getItem("ugk.taskShare.theme"), "light");
});

test("task-share pages set saved theme before loading CSS", () => {
	for (const file of [
		"docs/task-share/index.html",
		"docs/task-share/marketplace/index.html",
		"docs/task-share/upload/index.html",
		"docs/task-share/account/index.html",
		"docs/task-share/admin/index.html",
		"docs/task-share/cli-auth/index.html",
	]) {
		const html = readFileSync(file, "utf8");
		const boot = html.indexOf("ugk.taskShare.theme");
		const css = html.indexOf('rel="stylesheet"');
		assert.ok(boot !== -1, `${file} missing early theme boot`);
		assert.ok(boot < css, `${file} loads CSS before applying saved theme`);
	}
});

test("task-share nav pages expose a theme switcher slot", () => {
	for (const file of [
		"docs/task-share/index.html",
		"docs/task-share/marketplace/index.html",
		"docs/task-share/upload/index.html",
		"docs/task-share/account/index.html",
		"docs/task-share/admin/index.html",
	]) {
		assert.match(readFileSync(file, "utf8"), /data-theme-switcher/, file);
	}
});

test("task-share product homepage points consumers to the marketplace", () => {
	const html = readFileSync("docs/task-share/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /<body class="marketplace-page product-home">/);
	assert.match(html, /不用会编程，也能让电脑替你跑任务/);
	assert.match(html, /assets\/ugk-pixel-logo\.svg/);
	assert.match(html, /npx ugk-install/);
	assert.match(html, /npm i -g ugk-agent/);
	assert.match(html, /git clone https:\/\/github\.com\/mhgd3250905\/ugk-tui\.git/);
	assert.match(html, /class="install-terminal"/);
	assert.match(html, /name="install-channel"/);
	assert.match(html, /id="install-github"/);
	assert.match(html, /class="install-segments"/);
	assert.match(html, /data-install-panel="quick"/);
	assert.match(html, /data-install-panel="npm"/);
	assert.match(html, /data-install-panel="github"/);
	assert.match(css, /\.install-terminal \{/);
	assert.match(css, /\.install-segments/);
	assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
	assert.match(css, /#install-quick:checked ~ \.install-terminal-body \[data-install-panel="quick"\]/);
	assert.match(css, /#install-github:checked ~ \.install-terminal-body \[data-install-panel="github"\]/);
	assert.match(html, /href="marketplace\/"/);
	assert.match(html, /assets\/ugk-console-screenshot\.png/);
	assert.match(html, /class="task-marquee"/);
	assert.match(html, /task-marquee-row-alt/);
	assert.match(html, /tone-video/);
	assert.match(html, /Browser Check/);
	assert.match(html, /Release Notes/);
	assert.doesNotMatch(html, /ugk task install /);
	assert.match(html, /class="product-app-shot"/);
	assert.doesNotMatch(html, /data-catalog/);
	assert.match(css, /animation-timeline:\s*scroll\(root block\)/);
	assert.doesNotMatch(css, /task-marquee 58s/);
});

test("task-share marketplace moved under marketplace route", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	assert.match(html, /<link rel="stylesheet" href="\.\.\/styles\.css">/);
	assert.match(html, /<script src="\.\.\/i18n\.js"><\/script>/);
	assert.match(html, /data-catalog/);
	assert.match(html, /href="\.\.\/upload\/"/);
	assert.match(html, /\.\.\/assets\/empty-taskbook\.png/);
});

test("task-share marketplace cards show version and bottom author", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /card-version/);
	assert.match(html, /t\.version/);
	assert.match(html, /card-author/);
	assert.match(html, /data-task-detail/);
	assert.match(html, /function openTaskDetail/);
	assert.match(html, /fetchTaskFile\(task,'skill\.md'\)/);
	assert.match(html, /runtimeInputMeta/);
	assert.doesNotMatch(html, /<span class="chip">@'\+author/);
	assert.match(css, /\.card-author \{[^}]*max-width:/);
	assert.match(css, /\.card-author \{[^}]*text-overflow: ellipsis/);
	assert.match(css, /\.task-glyph \{[^}]*cursor: pointer;/);
	assert.match(css, /\.task-detail-dialog \{/);
	assert.match(css, /\.task-detail-pre \{/);
});

test("task-share marketplace detail prefers editable public detail", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	assert.match(html, /function fetchTaskDetail/);
	assert.match(html, /\/api\/tasks\/'\+encodeURIComponent\(task\.name\)\+'\/detail/);
	assert.match(html, /detail\.trigger/);
	assert.match(html, /detail\.usage/);
});

test("task-share copy feedback keeps label and swaps icon", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /<symbol id="icon-check"/);
	assert.match(html, /data-copy-icon/);
	assert.match(html, /btn-copy/);
	assert.match(html, /setAttribute\('href','#icon-check'\)/);
	assert.doesNotMatch(html, /textContent=tr\('card\.copied'\)/);
	assert.match(css, /\.btn-copy \{[^}]*min-height: 34px;/);
	assert.match(css, /\.btn-copy \{[^}]*background: var\(--control-bg-soft\);/);
	assert.match(css, /\.btn-copy \{[^}]*align-self: center;/);
});

test("task-share marketplace uses cache and optimistic metric feedback", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /sessionStorage\.getItem\(catalogCacheKey\)/);
	assert.match(html, /function optimisticTaskAction/);
	assert.match(html, /function rollbackTaskAction/);
	assert.match(html, /statsRefreshPromise/);
	assert.match(html, /if\(!renderCatalogFromCache\(\)\)refreshCatalog\(\)/);
	assert.match(html, /if\(session\.user\)refreshStats\(\)/);
	assert.match(css, /--metric-like-text:/);
	assert.match(css, /--metric-save-text:/);
	assert.match(css, /\.metric-like \{ --metric-color: var\(--metric-like\); --metric-text: var\(--metric-like-text\); \}/);
	assert.match(css, /\.metric\[data-busy="true"\]/);
});

test("task-share marketplace paginates growing catalogs", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /const catalogPageSize=12/);
	assert.match(html, /let catalogVisibleLimit=catalogPageSize/);
	assert.match(html, /data-catalog-more/);
	assert.match(html, /function showMoreTasks/);
	assert.match(html, /catalogVisibleLimit=Math\.min\(visibleCards\.length,catalogVisibleLimit\+catalogPageSize\)/);
	assert.match(css, /\.catalog-more \{/);
});

test("task-share marketplace sorts cards immediately after rendering", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	assert.match(html, /function renderCatalogTasks[\s\S]*bindCards\(\);filterTasks\(\);[\s\S]*}\nfunction renderCatalogFromCache/);
});

test("task-share admin submissions show version", () => {
	const html = readFileSync("docs/task-share/admin/index.html", "utf8");
	assert.match(html, /t\.version/);
	assert.match(html, /card-version/);
});

test("task-share account page manages submissions with withdraw and archive UI", () => {
	const html = readFileSync("docs/task-share/account/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /data-account-summary/);
	assert.match(html, /accountSubmissionRows/);
	assert.match(html, /data-withdraw-submission/);
	assert.match(html, /data-edit-submission-detail/);
	assert.match(html, /function openDetailEditor/);
	assert.match(html, /\/api\/account\/submissions\/'\+encodeURIComponent\(id\)\+'\/detail/);
	assert.match(html, /account\.withdraw/);
	assert.match(html, /account\.editDetail/);
	assert.match(html, /account\.archivedSubmissions/);
	assert.match(css, /\.account-dashboard/);
	assert.match(css, /\.account-list/);
	assert.match(css, /\.status-chip/);
	assert.match(css, /\.detail-editor-grid/);
});

test("cli auth page uses the marketplace shell and localized copy", () => {
	const html = readFileSync("docs/task-share/cli-auth/index.html", "utf8");
	assert.match(html, /<body class="marketplace-page">/);
	assert.match(html, /class="page-head"/);
	assert.match(html, /class="panel"/);
	assert.doesNotMatch(html, /style="/);
	assert.match(html, /data-i18n="cli.kicker"/);
	assert.match(html, /data-i18n="cli.initial.title"/);
	assert.match(html, /data-i18n="cli.initial.message"/);
	assert.match(html, /removeAttribute\("data-i18n"\)/);

	const { window } = loadI18n("?lang=zh-CN");
	assert.equal(window.UGKI18N.t("cli.done.title"), "授权完成");
	assert.equal(window.UGKI18N.t("cli.confirm.action"), "授权");
});

test("task-share mobile nav keeps theme and auth actions inside the menu", () => {
	for (const file of [
		"docs/task-share/marketplace/index.html",
		"docs/task-share/upload/index.html",
		"docs/task-share/account/index.html",
		"docs/task-share/admin/index.html",
	]) {
		const html = readFileSync(file, "utf8");
		const menuActions = html.match(/<div class="nav-menu-actions">([\s\S]*?)<\/div>/)?.[1] || "";
		assert.match(menuActions, /data-theme-switcher[\s\S]*data-language-switcher/, file);
		assert.match(html, /data-auth-link/, file);
	}
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(css, /body\[data-signed-in="true"\] \[data-auth-link\]/);
	assert.match(css, /\.nav-actions \[data-theme-switcher\]/);
	assert.match(css, /\.nav-actions \[data-language-switcher\]/);
	assert.match(css, /\.nav-menu-actions/);
	assert.match(css, /\.nav-menu-actions \.btn \{[^}]*border-radius: var\(--pill\)/);
	assert.match(css, /\.nav-menu-actions \.btn-primary/);
});

test("task-share mobile keeps marketplace search compact", () => {
	const html = readFileSync("docs/task-share/marketplace/index.html", "utf8");
	const css = readFileSync("docs/task-share/styles.css", "utf8");
	assert.match(html, /data-search[^>]*name="q"|name="q"[^>]*data-search/);
	assert.match(html, /data-category-filter[^>]*name="category"|name="category"[^>]*data-category-filter/);
	assert.match(html, /data-sort[^>]*name="sort"|name="sort"[^>]*data-sort/);
	assert.match(css, /\.search-status \{ display: none; \}/);
	assert.match(css, /\.toolbar select\.search \{ display: none; \}/);
});

test("task-share pages expose basic SEO and main landmark", () => {
	for (const file of [
		"docs/task-share/index.html",
		"docs/task-share/marketplace/index.html",
		"docs/task-share/upload/index.html",
		"docs/task-share/account/index.html",
		"docs/task-share/admin/index.html",
		"docs/task-share/cli-auth/index.html",
	]) {
		const html = readFileSync(file, "utf8");
		assert.match(html, /<meta name="description" content="[^"]+">/, file);
		assert.match(html, /<main[\s>]/, file);
		assert.match(html, /<link rel="icon" href="\/favicon\.ico">/, file);
	}
});

test("task-share static crawler files are real files", () => {
	assert.match(readFileSync("docs/task-share/robots.txt", "utf8"), /^User-agent: \*/);
	assert.match(readFileSync("docs/task-share/llms.txt", "utf8"), /^# UGK/);
	assert.ok(existsSync("docs/task-share/favicon.ico"));
	const favicon = readFileSync("docs/task-share/favicon.ico");
	assert.equal(favicon[0], 0);
	assert.equal(favicon[1], 0);
	assert.equal(favicon[2], 1);
	assert.equal(favicon[3], 0);
});
