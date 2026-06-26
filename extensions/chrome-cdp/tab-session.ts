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
 * ponytail: 不做启动时孤儿 tab 扫描。finally 必回收,孤儿只在 main 自身崩溃时残留(概率低)。
 * ceiling:若日后 main 崩溃残留 tab 变多,升级路径是启动时扫 title 前缀关掉(给 worker tab 打标记)。
 */
import type { WorkerLifecycle } from "../shared/worker-lifecycle.ts";
import { closeChromeTab, createChromeCdpClient, createChromeTab } from "./client.ts";

export interface CdpTabLifecycleDeps {
	// ponytail: 可选 DI,供测试注入 fake fetch。生产路径不传,走全局 fetch(与 client.ts 一致)。
	fetch?: typeof fetch;
}

export function makeCdpTabLifecycle(port: number, deps: CdpTabLifecycleDeps = {}): WorkerLifecycle {
	const client = () => createChromeCdpClient({ port, fetch: deps.fetch });
	let tabId: string | undefined;
	return {
		async beforeSpawn(env) {
			// ponytail: about:blank 起 tab。worker 进程内 navigate 到真实目标页(B 站 BV 页等)。
			const tab = await createChromeTab(client(), "about:blank");
			tabId = tab.id;
			env.UGK_CDP_TAB_ID = tabId;
		},
		async afterClose() {
			// finally 保证调到这里。tabId 空说明 beforeSpawn 没成功开 tab(幂等,不炸)。
			if (tabId) {
				await closeChromeTab(client(), tabId).catch(() => {});
				tabId = undefined;
			}
		},
	};
}
