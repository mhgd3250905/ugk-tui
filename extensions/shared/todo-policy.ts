/**
 * TodoWrite 触发规则 —— 注入 system prompt 的硬规则,让复杂任务稳定触发 TodoWrite。
 *
 * 为什么需要:光靠工具 description 是"软引导",模型可选不调。Claude Code/Codex 之所以
 * 稳定用 todo,是因为 system prompt 里有硬规则。本 snippet 把 ugk 的 todo 触发
 * 从"软引导"升级成"硬规则"。
 *
 * 放在 before_agent_start / system prompt 里(见 extensions/index.ts)。
 */
export const TODO_PROMPT_SNIPPET = [
	"[复杂任务用 TodoWrite]",
	"遇到满足以下任一条件的任务,在动手前先用 TodoWrite 工具建立 checklist:",
	"- 需要 3 步以上,或会改动多个文件",
	"- 需要事中跟踪进度或事后验证",
	"- 是非平凡的实现/重构/排查工作",
	"规则:同时最多一项 in_progress;完成一项立刻标 completed;发现新工作就更新列表,别假装原计划完美。",
	"简单单步问题(查个定义、改一行、回答个事实)不要用 TodoWrite。",
].join("\n");
