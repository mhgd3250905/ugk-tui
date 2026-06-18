import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveFlowTaskDir } from "./task-store.ts";

/**
 * Driver 执行期间的 task 设计资产写保护。
 *
 * 威胁模型:不是恶意 agent,而是 agent 不小心写了不该写的文件——比如 driver
 * 觉得"我顺手把 SKILL.md 改一下吧"。task.json 的 status 由状态机独占写权保证
 * (transition),这里只保护 driver 既不该改、runtime 在 driver 期间也不改的
 * **task 设计资产**:SKILL.md / todo.template.md / validator.md / schema。
 *
 * 不保护 task.json:runtime 在 driver 期间会写它的 status(prove-pass 等 transition),
 * 锁了会让 runtime 自己失败。task.json 的 status 由状态机 + normalizeLegacyState 兜底。
 * 不保护 run 产物(status.json/validation.json/review.json):runtime 持续写 status.json。
 *
 * 保护方式:driver session 活跃期间,把 task 设计资产设为 OS 只读(chmod 0444)。
 * agent 的 write 工具会直接 EPERM 失败。driver 结束后恢复可写(0644)。
 *
 * 安全保证:lock 返回 guard,unlock 必须在 driver 终态调用以恢复可写,即使抛错。
 */

const READONLY_MODE = 0o444;
const WRITABLE_MODE = 0o644;

/**
 * driver 期间受保护的 task 设计资产。task.json 不在内(runtime 要写 status);
 * status.json 等 run 产物也不在内(runtime 持续写)。
 */
const PROTECTED_DESIGN_ASSETS = [
	"SKILL.md",
	"todo.template.md",
	"validator.md",
	"input.schema.json",
	"output.schema.json",
];

function protectedAssetPaths(cwd: string, taskId: string): string[] {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	return PROTECTED_DESIGN_ASSETS.map((asset) => path.join(taskDir, asset));
}

export interface FlowWriteGuard {
	/** 受保护文件中实际被锁定的路径(只锁定已存在的文件)。 */
	readonly lockedPaths: readonly string[];
	/** 恢复所有锁定文件为可写。幂等。 */
	unlock(): void;
}

/**
 * 锁定 task 资产为只读。只锁定已存在的文件(资产可能不全,那是 gate 的事,不是这里的事)。
 * 返回 guard;调用方必须在 finally 里 unlock()。
 */
export function lockTaskAssets(cwd: string, taskId: string): FlowWriteGuard {
	const lockedPaths: string[] = [];
	for (const filePath of protectedAssetPaths(cwd, taskId)) {
		if (!existsSync(filePath)) {
			continue;
		}
		try {
			chmodSync(filePath, READONLY_MODE);
			lockedPaths.push(filePath);
		} catch {
			// 锁定失败不阻断 driver:跨平台差异或权限问题时,降级为不锁(prompt 仍是防线)。
			// 真正的保护由状态机独占写权保证;这里只是额外硬约束。
		}
	}
	return {
		lockedPaths,
		unlock() {
			for (const filePath of lockedPaths) {
				try {
					chmodSync(filePath, WRITABLE_MODE);
				} catch {
					// 恢复失败尽力而为:文件可能在期间被删除。
				}
			}
		},
	};
}
