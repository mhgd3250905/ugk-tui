/**
 * Per-worker CDP tab 生命周期 —— 消除并行 worker 抢同一 Chrome tab 导致的数据错乱。
 *
 * 机制:每个 worker spawn 前由 main 进程代码(subagent.ts 的 runSingleAgent)开一个专属 tab,
 * 把 tabId 注入 env `UGK_CDP_TAB_ID`;worker 进程内的 chrome_cdp 工具读它作默认 target
 * (见 config.ts 的 resolveChromeCdpTarget),不再 fallback 到 tabs[0]。
 * worker 进程 close 后(含 SIGKILL,由 main 的 finally 保证)关掉这个 tab。
 *
 * 边界:本模块只负责 tab 的开/关。target 的"默认绑定"逻辑在 config.ts(它读 env,与 worker 无关)。
 * subagent.ts 只认识 WorkerLifecycle 契约,不认识 chrome-cdp —— 解耦点。
 *
 * 可观测性:每次 open/close/error 写一行到 cdp-tab.log(tail -f 可看实时进度)。
 * 默认开;UGK_CDP_TAB_LOG=0 关。诊断并行隔离问题、Chrome 连接问题的唯一抓手。
 *
 * ponytail: 不做启动时孤儿 tab 扫描。finally 必回收,孤儿只在 main 自身崩溃时残留(概率低)。
 * ceiling:若日后 main 崩溃残留 tab 变多,升级路径是启动时扫 title 前缀关掉(给 worker tab 打标记)。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerLifecycle } from "../shared/worker-lifecycle.ts";
import { closeChromeTab, createChromeCdpClient, createChromeTab } from "./client.ts";

// ponytail: 简单 appendFileSync + 时间戳前缀,够用。写到 agent 目录下,跨 run 保留,
// worker 子进程也能写(同一文件系统)。要并发/轮转再升级。
function cdpTabLogPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "logs", "cdp-tab.log");
}

function tabLog(line: string): void {
	// ponytail: 默认开(诊断必须),UGK_CDP_TAB_LOG=0 关。写失败静默(日志不能阻塞主流程)。
	if (process.env.UGK_CDP_TAB_LOG === "0") return;
	try {
		const logPath = cdpTabLogPath();
		mkdirSync(path.dirname(logPath), { recursive: true });
		const ts = new Date().toISOString();
		appendFileSync(logPath, `[${ts}] ${line}\n`);
	} catch {
		/* 日志写入失败不该影响 tab 生命周期 */
	}
}

export interface CdpTabLifecycleDeps {
	// ponytail: 可选 DI,供测试注入 fake fetch。生产路径不传,走全局 fetch(与 client.ts 一致)。
	fetch?: typeof fetch;
	// ponytail: 可选日志注入(测试默认禁用,避免污染生产 cdp-tab.log)。
	log?: (line: string) => void;
}

export function makeCdpTabLifecycle(port: number, deps: CdpTabLifecycleDeps = {}): WorkerLifecycle {
	const client = () => createChromeCdpClient({ port, fetch: deps.fetch });
	// 测试传 deps.log=()=>{} 禁用日志;生产不传 → tabLog(写文件,默认开)。
	const log = deps.log ?? tabLog;
	let tabId: string | undefined;
	return {
		async beforeSpawn(env) {
			// ponytail: about:blank 起 tab。worker 进程内 navigate 到真实目标页(B 站 BV 页等)。
			try {
				const tab = await createChromeTab(client(), "about:blank");
				tabId = tab.id;
				env.UGK_CDP_TAB_ID = tabId;
				log(`OPEN  port=${port} tab=${tabId} url=about:blank`);
			} catch (error) {
				// ponytail: 把含糊的底层错(fetch failed / ECONNREFUSED)翻译成可操作的提示。
				// Chrome 没起是最高频原因 —— 直接告诉用户 /cdp launch。
				const msg = error instanceof Error ? error.message : String(error);
				log(`ERROR port=${port} stage=open msg=${msg}`);
				const hint = /fetch failed|ECONNREFUSED|Failed to fetch|NetworkError/i.test(msg)
					? `Chrome CDP 未连接(port ${port})。请先运行 /cdp launch 启动带调试端口的 Chrome。`
					: `CDP 开 tab 失败(port ${port}): ${msg}`;
				throw new Error(hint);
			}
		},
		async afterClose() {
			// finally 保证调到这里。tabId 空说明 beforeSpawn 没成功开 tab(幂等,不炸)。
			if (!tabId) return;
			const closingTabId = tabId;
			tabId = undefined;
			try {
				await closeChromeTab(client(), closingTabId);
				log(`CLOSE port=${port} tab=${closingTabId} ok`);
			} catch (error) {
				// ponytail: close 是 best-effort。失败说明 tab 已没了或 Chrome 重启 —— 不阻塞 worker 回收,但记下来。
				const msg = error instanceof Error ? error.message : String(error);
				log(`WARN  port=${port} tab=${closingTabId} close-failed msg=${msg}`);
			}
		},
	};
}
