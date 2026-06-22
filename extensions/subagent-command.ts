import * as fs from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./subagent-agents.ts";

const INHERIT_MODEL = "继承 main/default";

function modelValue(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

export async function setAgentModel(filePath: string, model: string | undefined): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		const content = await fs.readFile(filePath, "utf8");
		const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
		if (!match) throw new Error("Agent file has no YAML frontmatter");

		let frontmatter = match[0];
		if (!model) {
			frontmatter = frontmatter.replace(/^model\s*:.*(?:\r?\n)?/m, "");
		} else if (/^model\s*:/m.test(frontmatter)) {
			frontmatter = frontmatter.replace(/^model\s*:.*$/m, `model: ${quoteYamlString(model)}`);
		} else {
			frontmatter = frontmatter.replace(/(\r?\n)---$/, `$1model: ${quoteYamlString(model)}$1---`);
		}
		await fs.writeFile(filePath, frontmatter + content.slice(match[0].length), "utf8");
	});
}

export default function registerSubagentCommand(pi: ExtensionAPI) {
	pi.registerCommand("subagent", {
		description: "列出 subagent 并设置模型",
		handler: async (_args, ctx) => {
			const { agents } = discoverAgents(ctx.cwd, "both");
			if (agents.length === 0) {
				ctx.ui.notify("没有找到 subagent。", "warning");
				return;
			}

			const agentLabels = new Map(
				agents.map((agent) => [
					`${agent.name} · ${agent.model ?? "inherit"} · ${agent.source}`,
					agent,
				]),
			);
			const agentChoice = await ctx.ui.select("Subagents", Array.from(agentLabels.keys()));
			if (!agentChoice) return;
			const agent = agentLabels.get(agentChoice);
			if (!agent) return;

			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("没有可用模型。请先配置 API 或使用 /login。", "warning");
				return;
			}

			const modelLabels = new Map(models.map((model) => [`${modelValue(model)} · ${model.name}`, model]));
			const modelChoice = await ctx.ui.select(`${agent.name} model`, [INHERIT_MODEL, ...modelLabels.keys()]);
			if (!modelChoice) return;

			const selected = modelChoice === INHERIT_MODEL ? undefined : modelValue(modelLabels.get(modelChoice)!);
			await setAgentModel(agent.filePath, selected);
			ctx.ui.notify(`已保存 ${agent.name} 模型设置，下一次 subagent 调用生效。`, "info");
		},
	});
}
