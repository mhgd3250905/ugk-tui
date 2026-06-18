import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, readJsonOptional, readJsonStrict } from "./flow-fs.ts";
import { signRecord } from "./flow-signing.ts";
import { getProjectKey } from "./task-store.ts";

/** validation.json 签名覆盖的关键字段:防 agent 把 FAIL 改成 PASS。 */
const VALIDATION_SIGNED_FIELDS = ["taskId", "runId", "result", "scope", "createdAt"];

export type FlowValidationResult = "PASS" | "FAIL";

/**
 * 校验范围。当前只有 structural:证明 run 的产物结构齐全合法(文件存在、JSON 合法、
 * 满足 schema、有证据、有 progress)。它**不判断业务质量**——业务质量是 review 的
 * 唯一职责。这个字段让产物的消费者永远清楚一个 PASS 意味着什么,避免把"结构对"
 * 误读为"结果可接受"。旧 validation.json 没有此字段,读取时默认 structural。
 */
export type FlowValidationScope = "structural";

export interface FlowRunValidation {
	taskId: string;
	runId: string;
	phase: "prove" | "run";
	result: FlowValidationResult;
	scope: FlowValidationScope;
	summary: string;
	issues: string[];
	outputPreview?: Record<string, unknown>;
	artifacts: {
		resultJson: string;
		evidenceDir: string;
		progressMd: string;
		validationJson: string;
		validationMd: string;
	};
	createdAt: string;
	nextStep: string;
}

interface ValidateFlowRunArgs {
	cwd: string;
	taskId: string;
	runId: string;
	taskDir: string;
	runDir: string;
	phase: "prove" | "run";
	now?: Date;
}

function optionalSchemaIssues(value: unknown, schema: unknown, pathLabel = "result"): string[] {
	if (!isRecord(schema)) {
		return [];
	}
	const issues: string[] = [];
	if (schema.type === "object" && !isRecord(value)) {
		return [`${pathLabel} must be object`];
	}
	if (schema.type === "object" && isRecord(value)) {
		const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
		for (const key of required) {
			if (!(key in value)) {
				issues.push(`${pathLabel}.${key} is required`);
			}
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			issues.push(...optionalSchemaIssues(value[key], propertySchema, `${pathLabel}.${key}`));
		}
	}
	if (schema.type === "string" && typeof value !== "string") {
		issues.push(`${pathLabel} must be string`);
	}
	if (schema.type === "string" && typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		issues.push(`${pathLabel} exceeds maxLength ${schema.maxLength}`);
	}
	if (schema.type === "array" && !Array.isArray(value)) {
		issues.push(`${pathLabel} must be array`);
	}
	if (schema.type === "array" && Array.isArray(value) && isRecord(schema.items)) {
		value.forEach((item, index) => {
			issues.push(...optionalSchemaIssues(item, schema.items, `${pathLabel}[${index}]`));
		});
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		issues.push(`${pathLabel} must be one of ${schema.enum.map(String).join(", ")}`);
	}
	return issues;
}

function evidenceHasFiles(evidenceDir: string): boolean {
	try {
		return readdirSync(evidenceDir).some((name) => {
			const filePath = path.join(evidenceDir, name);
			return statSync(filePath).isFile() && statSync(filePath).size > 0;
		});
	} catch {
		return false;
	}
}

function summarizeOutput(output: unknown): string {
	if (!isRecord(output)) {
		return "output/result.json is not an object";
	}
	if (typeof output.summary === "string" && output.summary.trim()) {
		return output.summary.trim();
	}
	if (typeof output.title === "string" && output.title.trim()) {
		return output.title.trim();
	}
	const firstKey = Object.keys(output)[0];
	return firstKey ? `${firstKey}: ${JSON.stringify(output[firstKey])}` : "empty result object";
}

function previewOutput(output: unknown): Record<string, unknown> | undefined {
	if (!isRecord(output)) {
		return undefined;
	}
	const preview: Record<string, unknown> = {};
	for (const key of ["title", "summary", "installCommands", "startCommands", "sourceFile", "pathUsed"]) {
		if (key in output) {
			preview[key] = output[key];
		}
	}
	return Object.keys(preview).length > 0 ? preview : output;
}

function renderValidationMarkdown(validation: FlowRunValidation): string {
	const scopeNote = validation.scope === "structural"
		? "本结果只代表**结构校验**(产物齐全、合法、有证据)。它不判断业务质量——业务可接受性是 review 的唯一职责。"
		: `Scope: ${validation.scope}`;
	return [
		`# Flow Run Validation - ${validation.taskId}/${validation.runId}`,
		"",
		`Result: ${validation.result}`,
		`Scope: ${validation.scope}`,
		`Summary: ${validation.summary}`,
		`Phase: ${validation.phase}`,
		`Created: ${validation.createdAt}`,
		`Next step: ${validation.nextStep}`,
		"",
		`> ${scopeNote}`,
		"",
		"## Issues",
		...(validation.issues.length > 0 ? validation.issues.map((issue) => `- ${issue}`) : ["- none"]),
		"",
		"## Output Preview",
		"```json",
		JSON.stringify(validation.outputPreview ?? {}, null, "\t"),
		"```",
		"",
	].join("\n");
}

export function validateFlowRun(args: ValidateFlowRunArgs): FlowRunValidation {
	const resultJson = path.join(args.runDir, "output", "result.json");
	const evidenceDir = path.join(args.runDir, "evidence");
	const progressMd = path.join(args.runDir, "progress.md");
	const validationJson = path.join(args.runDir, "validation.json");
	const validationMd = path.join(args.runDir, "validation.md");
	const schemaPath = path.join(args.taskDir, "output.schema.json");
	const issues: string[] = [];
	let output: unknown;

	if (!existsSync(resultJson)) {
		issues.push("missing output/result.json");
	} else {
		try {
			output = readJsonStrict(resultJson);
		} catch (error) {
			issues.push(`output/result.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (output !== undefined && existsSync(schemaPath)) {
		try {
			issues.push(...optionalSchemaIssues(output, readJsonStrict(schemaPath)));
		} catch (error) {
			issues.push(`output.schema.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (!evidenceHasFiles(evidenceDir)) {
		issues.push("evidence directory has no non-empty evidence files");
	}
	if (!existsSync(progressMd)) {
		issues.push("missing progress.md");
	}

	const result: FlowValidationResult = issues.length === 0 ? "PASS" : "FAIL";
	const summary = result === "PASS" ? summarizeOutput(output) : issues[0] ?? "validation failed";
	const validation: FlowRunValidation = {
		taskId: args.taskId,
		runId: args.runId,
		phase: args.phase,
		result,
		scope: "structural",
		summary,
		issues,
		outputPreview: previewOutput(output),
		artifacts: {
			resultJson,
			evidenceDir,
			progressMd,
			validationJson,
			validationMd,
		},
		createdAt: (args.now ?? new Date()).toISOString(),
		nextStep: `/flow task review ${args.taskId}/${args.runId}`,
	};

	// 签名关键字段:防 agent 把 FAIL 改成 PASS。runtime 独占签名。
	const sig = signRecord(getProjectKey(args.cwd), validation as unknown as Record<string, unknown>, VALIDATION_SIGNED_FIELDS);
	const withSig = { ...validation, _sig: sig };
	writeFileSync(validationJson, `${JSON.stringify(withSig, null, "\t")}\n`);
	writeFileSync(validationMd, renderValidationMarkdown(validation));
	return validation;
}

export function readFlowRunValidation(runDir: string): FlowRunValidation | undefined {
	const parsed = readJsonOptional(path.join(runDir, "validation.json"));
	if (!isRecord(parsed)) {
		return undefined;
	}
	// 旧 validation.json 没有 scope 字段,统一视为 structural。
	return { ...(parsed as unknown as FlowRunValidation), scope: "structural" };
}
