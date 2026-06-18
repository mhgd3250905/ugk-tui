import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveFlowTaskDir } from "./task-store.ts";

export const REQUIRED_FLOW_TASK_ASSETS = [
	"task.json",
	"SKILL.md",
	"todo.template.md",
	"validator.md",
	"input.schema.json",
	"output.schema.json",
];

export interface FlowTaskAssetValidation {
	ok: boolean;
	taskId: string;
	taskDir: string;
	issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

export function validateFlowTaskAssets(cwd: string, taskId: string): FlowTaskAssetValidation {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	const issues: string[] = [];
	for (const file of REQUIRED_FLOW_TASK_ASSETS) {
		if (!existsSync(path.join(taskDir, file))) {
			issues.push(`missing ${file}`);
		}
	}

	for (const file of ["task.json", "input.schema.json", "output.schema.json"]) {
		const filePath = path.join(taskDir, file);
		if (!existsSync(filePath)) {
			continue;
		}
		try {
			const parsed = readJsonFile(filePath);
			if (!isRecord(parsed)) {
				issues.push(`${file} must be a JSON object`);
			}
		} catch (error) {
			issues.push(`${file} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		ok: issues.length === 0,
		taskId,
		taskDir,
		issues,
	};
}
