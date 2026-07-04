import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import {
	readSettingsJson,
	resolveSettingsPath,
	updateSettingsJson,
	type SettingsIoDeps,
} from "../shared/settings-io.ts";
import { uiText } from "../shared/ui-language.ts";

const COMPACTION_MODEL_KEY = "compactionModel";

export interface CompactionModelSetting {
	provider: string;
	id: string;
}

function withDefaultExists(deps: SettingsIoDeps): SettingsIoDeps {
	return deps.exists ? deps : { ...deps, exists: fs.existsSync };
}

export function getCurrentCompactionModel(deps: SettingsIoDeps = {}): CompactionModelSetting | undefined {
	const settings = readSettingsJson(withDefaultExists(deps));
	const value = settings?.[COMPACTION_MODEL_KEY];
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const model = value as Record<string, unknown>;
	return typeof model.provider === "string" && typeof model.id === "string"
		? { provider: model.provider, id: model.id }
		: undefined;
}

export function setCompactionModel(model: CompactionModelSetting, deps: SettingsIoDeps = {}): void {
	updateSettingsJson({ [COMPACTION_MODEL_KEY]: model }, withDefaultExists(deps));
}

export function clearCompactionModel(deps: SettingsIoDeps = {}): void {
	const safeDeps = withDefaultExists(deps);
	const settings = readSettingsJson(safeDeps);
	if (!settings || !(COMPACTION_MODEL_KEY in settings)) return;

	delete settings[COMPACTION_MODEL_KEY];
	const settingsPath = resolveSettingsPath(safeDeps);
	const writeFile = safeDeps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = safeDeps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export default function registerModelPicker(pi: ExtensionAPI): void {
	pi.registerCommand("compaction-model", {
		description: uiText("选择上下文压缩用的模型(跨会话持久)", "Select compaction model (persists across sessions)"),
		handler: async (_args, ctx) => {
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(uiText("没有可用模型。请先配置 API 或使用 /login。", "No available models. Configure an API or use /login."), "warning");
				return;
			}

			const current = getCurrentCompactionModel();
			const labels = available.map((model) => {
				const display = ctx.modelRegistry.getProviderDisplayName(model.provider);
				const provider = display && display !== model.provider ? `${display} (${model.provider})` : model.provider;
				const selected = current?.provider === model.provider && current.id === model.id;
				return `${provider} / ${model.id}${selected ? " ✓" : ""}`;
			});
			const clearLabel = uiText("清除(回退默认压缩)", "Clear (fall back to default compaction)");
			const backLabel = uiText("返回", "Back");
			const choice = await ctx.ui.select(uiText("压缩模型", "Compaction Model"), [...labels, clearLabel, backLabel]);
			if (!choice || choice === backLabel) return;

			if (choice === clearLabel) {
				clearCompactionModel();
				ctx.ui.notify(uiText("已清除压缩模型,回退默认压缩。", "Cleared compaction model, falling back to default."), "info");
				return;
			}

			const picked = available[labels.indexOf(choice)];
			if (!picked) return;
			setCompactionModel({ provider: picked.provider, id: picked.id });
			ctx.ui.notify(
				uiText(
					`压缩模型已设为: ${picked.provider}/${picked.id}\n建议选择输入窗口足够大的模型。`,
					`Compaction model set to: ${picked.provider}/${picked.id}\nPrefer a model with a large enough input window.`,
				),
				"info",
			);
		},
	});
}
