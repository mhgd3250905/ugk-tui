import { complete } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uiText } from "../shared/ui-language.ts";
import { getCurrentCompactionModel } from "./model-picker.ts";

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function registerCustomCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const setting = getCurrentCompactionModel();
		if (!setting) return;

		const model = ctx.modelRegistry.find(setting.provider, setting.id);
		if (!model) {
			notify(
				ctx,
				uiText(
					`压缩模型 ${setting.provider}/${setting.id} 找不到,回退默认压缩`,
					`Compaction model ${setting.provider}/${setting.id} not found, falling back to default`,
				),
				"warning",
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			notify(ctx, uiText("压缩模型 auth 失败,回退默认压缩", "Compaction auth failed, falling back to default"), "warning");
			return;
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		notify(
			ctx,
			uiText(
				`压缩中:摘要 ${allMessages.length} 条消息(${tokensBefore.toLocaleString()} tokens),用 ${model.id}`,
				`Compacting: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}`,
			),
		);

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";
		const customFocus = event.customInstructions ? `\n\nUser focus:\n${event.customInstructions}` : "";

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `You are a conversation summarizer. Create a comprehensive summary capturing:${previousContext}${customFocus}

1. Main goals and objectives
2. Key decisions and their rationale
3. Important code changes, file modifications, technical details
4. Current state of ongoing work
5. Blockers, issues, open questions
6. Next steps planned

Be thorough but concise. The summary replaces the ENTIRE conversation history.

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(
				model,
				{ messages: summaryMessages },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
			);
			const summary = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) {
					notify(ctx, uiText("压缩摘要为空,回退默认压缩", "Compaction summary empty, falling back to default"), "warning");
				}
				return;
			}

			return { compaction: { summary, firstKeptEntryId, tokensBefore } };
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			notify(
				ctx,
				uiText(`压缩失败: ${message},回退默认压缩`, `Compaction failed: ${message}, falling back to default`),
				"error",
			);
			return;
		}
	});
}
