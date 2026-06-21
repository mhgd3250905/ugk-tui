/**
 * Judge delivery report formatting.
 *
 * Extracted from judge.ts to reduce its size. Pure functions, no side effects,
 * no dependencies on pi APIs or the judge runtime state.
 */
import type { DriverSummary } from "./judge-state.ts";
import type { JudgeFinalVerdict, TranscriptTail } from "./judge-utils.ts";

export function formatDeliveryReport(options: {
	status: "PASS" | "FAIL";
	finalVerdict: JudgeFinalVerdict;
	summary: DriverSummary;
	tail: TranscriptTail;
}): string {
	const truncateForDisplay = (value: string, maxLength: number): string => {
		const normalized = value.replace(/\s+/g, " ").trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 3)}...`;
	};
	const parseJsonText = (jsonText: string): string => {
		try {
			const value = JSON.parse(jsonText);
			if (Array.isArray(value)) {
				return value
					.map((item) => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")
					.filter(Boolean)
					.join("\n");
			}
			if (value && typeof value === "object" && "text" in value) {
				return String((value as { text?: unknown }).text ?? "");
			}
		} catch {
			return "";
		}
		return "";
	};
	const summarizeDisplayText = (value: string, maxLength: number): string => {
		const trimmed = value.trim();
		if (!trimmed) return "";
		const contentMatch = /^content=(\[.*\]|\{.*\})$/s.exec(trimmed);
		if (contentMatch) {
			const parsed = parseJsonText(contentMatch[1]);
			return parsed ? truncateForDisplay(parsed, maxLength) : "工具返回内容已隐藏,完整过程见 live.log";
		}
		if (/^content=\[/.test(trimmed) || /^content=\{/.test(trimmed)) {
			return "工具返回内容已隐藏,完整过程见 live.log";
		}
		return truncateForDisplay(trimmed, maxLength);
	};
	const extractEvidenceArtifacts = (): string[] => {
		const paths = new Set<string>();
		for (const item of options.finalVerdict.evidence) {
			const matches = item.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s`"',;，；。)）\]]+\.[A-Za-z0-9]{1,8}/g);
			for (const match of matches) {
				paths.add(match[0]);
			}
		}
		return Array.from(paths).slice(0, 8);
	};
	const formatArtifact = (artifact: DriverSummary["artifacts"][number]): string => `- 📄 ${artifact.path}`;
	const evidenceArtifacts = extractEvidenceArtifacts();
	const outputLines = options.summary.artifacts.length > 0
		? options.summary.artifacts.map(formatArtifact)
		: evidenceArtifacts.length > 0
			? evidenceArtifacts.map((path) => `- 📄 ${path}`)
		: options.tail.assistantOutput.trim()
			? [
				"- driver 未产出文件,以下为 driver 的结果摘要:",
				`  ${summarizeDisplayText(options.tail.assistantOutput, 500)}`,
			]
			: ["- ⚠️ driver 未产出可展示的结果(无文件、无输出摘要)。完整过程见 live.log。"];
	const evidenceLines = options.finalVerdict.evidence.map((item) => `- ${item}`);
	const paths = options.summary.pathsTried;
	const visiblePaths = paths.length > 15
		? [
			...paths.slice(0, 5).map((path, index) => ({ path, index })),
			{ omitted: paths.length - 7 },
			...paths.slice(-2).map((path, offset) => ({ path, index: paths.length - 2 + offset })),
		]
		: paths.map((path, index) => ({ path, index }));
	const pathLines = visiblePaths.length > 0
		? visiblePaths.map((entry) => {
			if ("omitted" in entry) return `... 中间省略 ${entry.omitted} 步,完整过程见 live.log`;
			const state = entry.path.failed ? "✗" : "✓";
			const reason = entry.path.failed ? summarizeDisplayText(entry.path.resultSummary, 80) : "";
			const args = entry.path.failed && entry.path.argsSummary ? `; args: ${summarizeDisplayText(entry.path.argsSummary, 80)}` : "";
			return `${entry.index + 1}. ${entry.path.toolName} ${state}${reason ? ` - ${reason}` : ""}${args}`;
		})
		: ["- (none)"];
	const lines = [
		`${options.status === "PASS" ? "✅" : "❌"} Judge ${options.status}`,
		options.finalVerdict.reason,
		"",
		"📦 产出",
		...outputLines,
	];

	if (evidenceLines.length > 0) {
		lines.push("", "🔍 验收证据", ...evidenceLines);
	}

	lines.push(
		"",
		`🛣️ 走过的路径(${paths.length} 步,steer ${options.summary.steerCount}/5)`,
		...pathLines,
	);

	return lines.join("\n");
}
