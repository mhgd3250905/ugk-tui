import { listTaskbooks, tasksRootUser } from "./task-book.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEDICATED_TAG = "dedicated";

function isDedicated(item: { tags?: string[] }): boolean {
	return Array.isArray(item.tags) && item.tags.includes(DEDICATED_TAG);
}

function inputFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const runtimeInput = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(runtimeInput) ? runtimeInput.filter((item) => typeof item === "string") : [];
}

function formatInputField(contract: unknown, field: string): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return field;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return field;
	const fieldMeta = (meta as Record<string, unknown>)[field];
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return field;
	const base = "default" in fieldMeta ? `${field}=${String((fieldMeta as Record<string, unknown>).default)}` : field;
	const allowed = (fieldMeta as Record<string, unknown>).allowedValues;
	return Array.isArray(allowed) && allowed.length > 0 ? `${base}{${allowed.map(String).join("|")}}` : base;
}

function formatTaskbookLine(item: Awaited<ReturnType<typeof listTaskbooks>>[number]): string {
	const fields = inputFields(item.contract);
	const input = fields.length > 0 ? ` (input: ${fields.map((field) => formatInputField(item.contract, field)).join(", ")})` : "";
	// ponytail: 展示外部 CLI 依赖,让 agent 一眼看到"这 task 要 yt-dlp/ffmpeg"——可移植性的迁移说明书。
	const binaries = binariesLine(item.contract);
	return `- ${item.name} — ${item.description}${input}${binaries}`;
}

function binariesLine(contract: unknown): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "";
	const requiredBinaries = (contract as Record<string, unknown>).requiredBinaries;
	if (!Array.isArray(requiredBinaries)) return "";
	// ponytail: 过滤规则与 task.ts 的 summarize/missing 对齐(滤空白),避免空串显示成尾随逗号。
	const names = requiredBinaries.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return names.length > 0 ? ` [needs: ${names.join(", ")}]` : "";
}

// ponytail: 专用 task 的渐进式披露——skill 标准的三层模型。
// 专用 task(低频/细分,如"糖尿病新闻整理")不进 prompt 清单(避免闲聊误触发),
// 而是落到这个文件;agent 仅当用户点名 task 名时 read 它,找到匹配项再 run_task。
// 通用 task 留在 prompt 里保留自动触发能力(藏了就废)。
export function dedicatedIndexPath(): string {
	return path.join(tasksRootUser(), "_dedicated-index.md");
}

export async function buildTaskbookPrompt(cwd: string, options: { includeDedicatedDetails?: boolean } = {}): Promise<string> {
	const items = await listTaskbooks(cwd);
	if (items.length === 0) return "";
	const general = items.filter((item) => !isDedicated(item));
	const dedicated = items.filter(isDedicated);
	const lines = ["## 可用 task(确定性、已机器验收的固定任务)", "下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:", ""];
	if (general.length > 0) {
		lines.push(...general.map(formatTaskbookLine));
	}
	// ponytail: 专用 task 不列详情,只给指针。是否有指针取决于当前是否存在专用 task,
	// 所以翻转专用标记后必须重生成 prompt(见 task.ts 详情页菜单回调)。
	if (dedicated.length > 0 && options.includeDedicatedDetails) {
		lines.push("", "## 专用 task", ...dedicated.map(formatTaskbookLine));
	} else if (dedicated.length > 0) {
		lines.push("", "## 专用 task(仅当用户在消息里明确点名 task 名时才使用,不要主动推荐)");
		lines.push(`专用 task 清单见文件: ${dedicatedIndexPath()}`);
		lines.push("需要时用 read 工具读取该文件,找到匹配项后用 run_task 执行。不要在用户未点名时主动 read 或推荐。");
	}
	return lines.join("\n");
}

export async function buildDedicatedIndex(cwd: string): Promise<string> {
	const items = (await listTaskbooks(cwd)).filter(isDedicated);
	if (items.length === 0) return "";
	return [
		"# 专用 task 清单",
		"",
		"下列 task 已标记为专用(低频/细分场景)。仅当用户在消息里明确点名其中某个 task 名(或描述高度匹配某项)时才调用。",
		"调用方式: 用 run_task 工具,name 填下方匹配项的 name,input 填用户的自然语言需求。",
		"",
		...items.map(formatTaskbookLine),
	].join("\n");
}

// ponytail: 无专用 task 时删文件而非写空文件,避免 agent read 到一份"空清单"误以为系统异常;
// 有内容时确保父目录存在(user scope 根目录通常已存在, mkdir 兜底防 ENOENT)。
export async function regenerateDedicatedIndex(cwd: string): Promise<void> {
	const indexPath = dedicatedIndexPath();
	const content = await buildDedicatedIndex(cwd);
	if (!content) {
		await rm(indexPath, { force: true });
		return;
	}
	await mkdir(path.dirname(indexPath), { recursive: true });
	await writeFile(indexPath, content, "utf8");
}
