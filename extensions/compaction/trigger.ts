import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uiText } from "../shared/ui-language.ts";
import { getThresholdTokens } from "./thresholds.ts";

/**
 * ponytail: 自动触发的纯判断逻辑,抽出来便于单测。无副作用,只决定"这一轮该不该压"。
 *
 * 触发条件:有上一轮记录(prev 非 undefined/null)、上一轮在阈值下(prev <= threshold)、
 * 这一轮跨过阈值(curr > threshold)。即"从低位跨到高位"的边沿触发,持续超阈值不重复触发。
 */
export function shouldAutoCompact(
	previousTokens: number | null | undefined,
	currentTokens: number | null,
	threshold: number,
): boolean {
	if (currentTokens === null) return false;
	if (threshold <= 0) return false;
	const crossedThreshold = previousTokens !== undefined && previousTokens !== null && previousTokens <= threshold;
	return crossedThreshold && currentTokens > threshold;
}

function triggerCompaction(ctx: ExtensionContext, customInstructions?: string): void {
	if (ctx.hasUI) ctx.ui.notify(uiText("开始压缩上下文", "Compaction started"), "info");
	ctx.compact({
		customInstructions,
		onComplete: () => {
			if (ctx.hasUI) ctx.ui.notify(uiText("压缩完成", "Compaction completed"), "info");
		},
		onError: (error) => {
			if (ctx.hasUI) {
				ctx.ui.notify(uiText(`压缩失败: ${error.message}`, `Compaction failed: ${error.message}`), "error");
			}
		},
	});
}

export default function registerTrigger(pi: ExtensionAPI): void {
	let previousTokens: number | null | undefined;

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		try {
			const threshold = getThresholdTokens(usage?.contextWindow);
			if (shouldAutoCompact(previousTokens, currentTokens, threshold)) {
				triggerCompaction(ctx);
			}
		} finally {
			// 无论是否触发,都更新 prev 供下一轮比较(空 currentTokens 时不更新,保留旧 prev)
			if (currentTokens !== null) previousTokens = currentTokens;
		}
	});

	pi.registerCommand("trigger-compact", {
		description: uiText("立即触发上下文压缩(可附自定义指令)", "Trigger compaction immediately (optional custom instructions)"),
		handler: async (args, ctx) => {
			triggerCompaction(ctx, args.trim() || undefined);
		},
	});
}
