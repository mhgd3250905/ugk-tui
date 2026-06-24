#!/usr/bin/env node
/**
 * ugk CLI 入口(npm bin 指向这里)
 *
 * 极薄包装:把 pi 作为内置依赖,用 -e 临时注入我们的扩展。
 * 用户打 `ugk` = 跑 pi + 自动加载 ugk 全部能力,全程不知 pi 存在。
 *
 * -e 走 temporary resolve(resource-loader.js),零全局副作用,不写 settings.json。
 * skills/prompts 通过 extensions/index.ts 的 resources_discover 事件随包加载。
 */

// pi 期望的运行时标记(见 pi cli.js:12)
process.env.PI_CODING_AGENT = "true";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildUgkCliArgs } from "./ugk-cli-args.js";
import { installUgkExtensionOverlayPatch } from "./ugk-extension-overlay-patch.js";
import { installUgkPackageUpdatePatch } from "./ugk-package-update-patch.js";
import { applyUgkRuntimePolicy } from "./ugk-runtime-policy.js";
import { installUgkSessionViewPatch } from "./ugk-session-view-patch.js";
import { ensureUgkQuietStartupDefault } from "./ugk-startup-settings.js";
import { runUgkUpdatePreflight } from "./update-preflight.js";
import { ensureWorkspaceTrusted } from "./workspace-trust.js";
import { runFlowCleanupOnce } from "./flow-cleanup.js";

applyUgkRuntimePolicy();

// 扩展文件绝对路径(与 cwd 无关,基于本文件位置定位)
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const update = await runUgkUpdatePreflight({
	argv: process.argv.slice(2),
	packageRoot,
});
if (update.action === "exit") {
	process.exit(update.exitCode ?? 0);
}

const trust = await ensureWorkspaceTrusted();
if (!trust.trusted) {
	console.error(trust.reason || "Workspace trust declined.");
	process.exit(1);
}

await runFlowCleanupOnce();

const { InteractiveMode, main } = await import("@earendil-works/pi-coding-agent");
// Install pi patches; warn if either fails to apply (e.g. pi upgrade changed internals).
if (!installUgkSessionViewPatch({ InteractiveMode })) {
	console.warn("ugk: session-view patch did not apply (pi version drift?). Session switching may be limited.");
}
if (!installUgkPackageUpdatePatch({ InteractiveMode })) {
	console.warn("ugk: package-update patch did not apply (pi version drift?). 'Run pi update' notices may reappear.");
}
if (!installUgkExtensionOverlayPatch({ InteractiveMode })) {
	console.warn("ugk: extension-overlay patch did not apply (pi version drift?). Extension inputs may flicker while Working is visible.");
}

ensureUgkQuietStartupDefault();

// 透传用户参数,追加 -e 注入我们的扩展
await main(buildUgkCliArgs(process.argv.slice(2), packageRoot));
