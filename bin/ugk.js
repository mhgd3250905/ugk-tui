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
import { dirname, join } from "node:path";
import { applyUgkRuntimePolicy } from "./ugk-runtime-policy.js";
import { ensureUgkQuietStartupDefault } from "./ugk-startup-settings.js";

applyUgkRuntimePolicy();

const { main } = await import("@earendil-works/pi-coding-agent");

// 扩展文件绝对路径(与 cwd 无关,基于本文件位置定位)
const here = dirname(fileURLToPath(import.meta.url));
const extPath = join(here, "..", "extensions", "index.ts");

ensureUgkQuietStartupDefault();

// 透传用户参数,追加 -e 注入我们的扩展
await main([...process.argv.slice(2), "-e", extPath]);
