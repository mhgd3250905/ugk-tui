import { listTaskbooks } from "./task-book.ts";

export async function buildTaskbookPrompt(cwd: string): Promise<string> {
	const items = await listTaskbooks(cwd);
	if (items.length === 0) return "";
	return [
		"## 可用 task(确定性、已机器验收的固定任务)",
		"下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:",
		"",
		...items.map((item) => `- ${item.name} — ${item.description}`),
	].join("\n");
}
