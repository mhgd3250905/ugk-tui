import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uiText } from "../shared/ui-language.ts";
import { getThresholdTokens } from "./thresholds.ts";

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
		if (currentTokens === null) return;

		const threshold = getThresholdTokens(usage?.contextWindow);
		if (threshold <= 0) {
			previousTokens = currentTokens;
			return;
		}

		const crossedThreshold = previousTokens !== undefined && previousTokens !== null && previousTokens <= threshold;
		previousTokens = currentTokens;
		if (!crossedThreshold || currentTokens <= threshold) return;

		triggerCompaction(ctx);
	});

	pi.registerCommand("trigger-compact", {
		description: uiText("立即触发上下文压缩(可附自定义指令)", "Trigger compaction immediately (optional custom instructions)"),
		handler: async (args, ctx) => {
			triggerCompaction(ctx, args.trim() || undefined);
		},
	});
}
