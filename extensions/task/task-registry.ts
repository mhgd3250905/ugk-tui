import { listTaskbooks } from "./task-book.ts";

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
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta) || !("default" in fieldMeta)) return field;
	return `${field}=${String((fieldMeta as Record<string, unknown>).default)}`;
}

function formatTaskbookLine(item: Awaited<ReturnType<typeof listTaskbooks>>[number]): string {
	const fields = inputFields(item.contract);
	const input = fields.length > 0 ? ` (input: ${fields.map((field) => formatInputField(item.contract, field)).join(", ")})` : "";
	return `- ${item.name} — ${item.description}${input}`;
}

export async function buildTaskbookPrompt(cwd: string): Promise<string> {
	const items = await listTaskbooks(cwd);
	if (items.length === 0) return "";
	return [
		"## 可用 task(确定性、已机器验收的固定任务)",
		"下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:",
		"",
		...items.map(formatTaskbookLine),
	].join("\n");
}
