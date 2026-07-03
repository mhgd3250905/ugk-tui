#!/usr/bin/env node
// dispatcher eval runner(通用):按 --task=<name> 加载任意 taskbook 的 contract/skill + cases,
// 用真实 LLM 跑 dispatcher 翻译路径,通用评判器逐字段判定,产 JSON+md 报告。
//
// 用法:
//   npm run eval:dispatcher -- --task=video-downloader
//   npm run eval:dispatcher -- --task=video-downloader --model=deepseek/deepseek-chat
//
// 需要真实 API key(DEEPSEEK_API_KEY 或 ~/.pi/agent/auth.json)。无 key 报错退出(fail-closed)。
// 不进 npm test / CI —— 手动跑。离线机制单测见 tests/task-dispatcher-eval.test.ts。
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { complete } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildTaskDispatcherPrompt, extractRuntimeInputFromText } from "../extensions/task/task-dispatcher.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesTaskbooksDir = path.join(root, "tests", "fixtures", "taskbooks");
const fixturesEvalsDir = path.join(root, "tests", "fixtures", "dispatcher-evals");

// ===== 通用评判器(纯函数,被单测直接 import 验证)=====
// rule 格式:"equals:<值>" | "omitted" | "absent" | "present" | "in:a|b|c"
// 返回 { ok: boolean, detail: string }

function ruleParts(rule) {
	const idx = rule.indexOf(":");
	return idx >= 0 ? { op: rule.slice(0, idx), arg: rule.slice(idx + 1) } : { op: rule, arg: undefined };
}

function isPresentValue(value) {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return false;
}

export function judgeField(actualValue, hasField, rule) {
	const { op, arg } = ruleParts(rule);
	switch (op) {
		case "equals": {
			const expected = arg;
			const actual = hasField ? String(actualValue) : undefined;
			return actual === expected
				? { ok: true, detail: `=${expected}` }
				: { ok: false, detail: `期望 ${expected},实际 ${actual === undefined ? "(字段不存在)" : actualValue}` };
		}
		case "path-equals": {
			// ponytail: 路径断言。Windows 上 dispatcher 可能把正斜杠翻成反斜杠(等价路径),
			// 严格 equals 会误判。归一化(全转 / 后比)避免这种非确定性假阴性。
			const expected = String(arg).replace(/\\/g, "/");
			const actual = hasField ? String(actualValue).replace(/\\/g, "/") : undefined;
			return actual === expected
				? { ok: true, detail: `路径=${expected}` }
				: { ok: false, detail: `期望路径 ${expected},实际 ${actual === undefined ? "(字段不存在)" : actualValue}` };
		}
		case "omitted":
		case "absent":
			return !hasField
				? { ok: true, detail: "字段已省略" }
				: { ok: false, detail: `期望 omitted,实际存在 ${JSON.stringify(actualValue)}` };
		case "present":
			return hasField && isPresentValue(actualValue)
				? { ok: true, detail: `字段存在 (${JSON.stringify(actualValue)})` }
				: { ok: false, detail: "期望 present,实际缺失或无效" };
		case "in": {
			const allowed = String(arg).split("|");
			// ponytail: in 原语支持 "omitted" 作为特殊成员 —— 当 allowed 含 "omitted" 且字段
			// 不存在时算通过。用于"省略或某值都算对"的断言(如有 default 的字段,dispatcher
			// 省略它和显式输出 default 值行为等价,两者都该判 PASS)。
			if (!hasField) {
				return allowed.includes("omitted")
					? { ok: true, detail: "字段省略(in:omitted)" }
					: { ok: false, detail: `期望 in ${allowed.join("|")},实际(字段不存在)` };
			}
			const actual = String(actualValue);
			return allowed.includes(actual)
				? { ok: true, detail: `${actual} in ${allowed.join("|")}` }
				: { ok: false, detail: `期望 in ${allowed.join("|")},实际 ${actualValue}` };
		}
		default:
			return { ok: false, detail: `未知评判原语: ${op}` };
	}
}

// 整体结果评判:支持 __outcome 特殊字段(如 "fails-required-gate")
export function judgeCase(actualOutput, parsedOk, assertSpec) {
	// __outcome 断言整体结果而非字段
	if (assertSpec.__outcome) {
		if (assertSpec.__outcome === "fails-required-gate") {
			// dispatcher 解析失败(无有效输出 或 抛错)算 PASS
			return {
				ok: !parsedOk,
				fieldResults: [],
				detail: parsedOk
					? "期望解析失败(required 缺失),但 dispatcher 返回了有效输出"
					: "正确解析失败(required 缺失)",
			};
		}
		return { ok: false, fieldResults: [], detail: `未知 __outcome: ${assertSpec.__outcome}` };
	}

	const output = actualOutput && typeof actualOutput === "object" && !Array.isArray(actualOutput) ? actualOutput : {};
	const fieldResults = [];
	let allOk = parsedOk; // dispatcher 没解析出 = 整体失败(除非 __outcome)
	for (const [field, rule] of Object.entries(assertSpec)) {
		const hasField = Object.prototype.hasOwnProperty.call(output, field);
		const result = judgeField(output[field], hasField, rule);
		fieldResults.push({ field, rule, ...result });
		if (!result.ok) allOk = false;
	}
	return { ok: allOk, fieldResults, detail: allOk ? "全部字段通过" : "存在失败字段" };
}

// ===== LLM 调用(复用 dispatcher 生产路径)=====

function parseCliArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--task=")) args.task = a.slice("--task=".length);
		else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
		else if (a === "--task") args.task = argv[++i];
		else if (a === "--model") args.model = argv[++i];
	}
	return args;
}

async function resolveModel(modelOverride) {
	const authStorage = AuthStorage.create();
	const registry = ModelRegistry.create(authStorage);
	let model;
	if (modelOverride) {
		const slash = modelOverride.indexOf("/");
		if (slash < 0) throw new Error(`--model 需用 provider/modelId 格式,如 deepseek/deepseek-chat。收到: ${modelOverride}`);
		const provider = modelOverride.slice(0, slash);
		const modelId = modelOverride.slice(slash + 1);
		model = registry.find(provider, modelId);
		if (!model) throw new Error(`找不到 model: ${modelOverride}。可用模型见 ugk /login 或 settings.json。`);
	} else {
		// 默认:取第一个有 auth 的可用 model
		const available = registry.getAvailable();
		if (available.length === 0) throw new Error("没有可用 model(无 API key / 未 login)。请配置 DEEPSEEK_API_KEY 或 ugk /login,或用 --model=provider/modelId 指定。");
		model = available[0];
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(`model ${model.provider}/${model.id} 没有 API key。请配置后重试。`);
	}
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function runOneCase(model, apiKey, headers, skill, contract, rawInput) {
	const prompt = buildTaskDispatcherPrompt(skill, contract, rawInput);
	const response = await complete(model, {
		messages: [{
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		}],
	}, { apiKey, headers, reasoningEffort: "medium" });
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const parsed = extractRuntimeInputFromText(text);
	return { rawText: text, parsed };
}

// ===== 报告生成 =====

function buildMarkdownReport(taskName, modelLabel, results) {
	const judged = results.filter((r) => r.kind === "judged");
	const open = results.filter((r) => r.kind === "open");
	const passed = judged.filter((r) => r.judgment.ok).length;
	const total = judged.length;
	const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
	const lines = [
		`# ${taskName} dispatcher eval`,
		"",
		`模型: ${modelLabel}  通过: ${passed}/${total} (${rate}%)${open.length ? `  另有 ${open.length} 条 open 用例(不计入)` : ""}`,
		"",
	];
	for (const r of results) {
		const icon = r.kind === "open" ? "🔍" : (r.judgment.ok ? "✅" : "❌");
		lines.push(`## ${icon} ${r.id} [${r.group}]: "${r.input}"`);
		if (r.kind === "open") {
			lines.push(`_open 用例(观察,不计通过率)_`);
			lines.push(`实际输出: \`${JSON.stringify(r.actual)}\``);
			lines.push(`说明: ${r.note}`);
			lines.push("");
			continue;
		}
		if (!r.parsedOk) {
			lines.push(`dispatcher 解析失败(无有效输出)。原始响应:`);
			lines.push("```");
			lines.push(r.rawText.slice(0, 500));
			lines.push("```");
		} else {
			lines.push(`实际: \`${JSON.stringify(r.actual)}\``);
		}
		if (!r.judgment.ok) {
			for (const fr of r.judgment.fieldResults) {
				if (!fr.ok) lines.push(`- **${fr.field}** (${fr.rule}): ${fr.detail}`);
			}
			if (r.judgment.fieldResults.length === 0) lines.push(`- ${r.judgment.detail}`);
		}
		if (r.note) lines.push(`_说明: ${r.note}_`);
		lines.push("");
	}
	return lines.join("\n");
}

// ===== main =====

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args.task) {
		console.error("用法: node scripts/eval-dispatcher.mjs --task=<name> [--model=provider/modelId]");
		process.exit(1);
	}
	const taskName = args.task;
	const contractPath = path.join(fixturesTaskbooksDir, taskName, "contract.json");
	const skillPath = path.join(fixturesTaskbooksDir, taskName, "skill.md");
	const casesPath = path.join(fixturesEvalsDir, `${taskName}.cases.json`);

	for (const p of [contractPath, skillPath, casesPath]) {
		if (!existsSync(p)) throw new Error(`缺少 fixture: ${p}`);
	}
	const contract = JSON.parse(await readFile(contractPath, "utf8"));
	const skill = await readFile(skillPath, "utf8");
	const casesFile = JSON.parse(await readFile(casesPath, "utf8"));
	const cases = Array.isArray(casesFile.cases) ? casesFile.cases : [];

	console.error(`[eval] task=${taskName} cases=${cases.length} 解析 model...`);
	const { model, apiKey, headers } = await resolveModel(args.model);
	const modelLabel = `${model.provider}/${model.id}`;
	console.error(`[eval] 使用 model=${modelLabel},开始逐条跑(${cases.length} 条)...`);

	const results = [];
	for (let i = 0; i < cases.length; i += 1) {
		const c = cases[i];
		process.stderr.write(`[eval] (${i + 1}/${cases.length}) ${c.id} "${c.input.slice(0, 30)}"... `);
		let actual;
		let parsedOk = false;
		let rawText = "";
		try {
			const r = await runOneCase(model, apiKey, headers, skill, contract, c.input);
			rawText = r.rawText;
			actual = r.parsed;
			parsedOk = actual !== undefined && actual !== null && typeof actual === "object";
		} catch (err) {
			// LLM 调用失败记录为解析失败
			rawText = String(err.message || err);
		}
		if (c.expected === "open") {
			results.push({ kind: "open", id: c.id, group: c.group, input: c.input, actual, parsedOk, rawText, note: c.note });
			process.stderr.write(`open(观察)\n`);
			continue;
		}
		const assertSpec = c.assert || {};
		const judgment = judgeCase(actual, parsedOk, assertSpec);
		results.push({ kind: "judged", id: c.id, group: c.group, input: c.input, actual, parsedOk, rawText, judgment, note: c.note });
		process.stderr.write(`${judgment.ok ? "PASS" : "FAIL"}\n`);
	}

	const reportJson = {
		task: taskName,
		model: modelLabel,
		timestamp: new Date().toISOString(),
		results,
	};
	const reportMd = buildMarkdownReport(taskName, modelLabel, results);
	const jsonPath = path.join(fixturesEvalsDir, `${taskName}.report.json`);
	const mdPath = path.join(fixturesEvalsDir, `${taskName}.report.md`);
	await writeFile(jsonPath, JSON.stringify(reportJson, null, 2), "utf8");
	await writeFile(mdPath, reportMd, "utf8");

	const judged = results.filter((r) => r.kind === "judged");
	const passed = judged.filter((r) => r.judgment.ok).length;
	console.error(`\n[eval] 完成: ${passed}/${judged.length} 通过。报告:`);
	console.error(`  ${mdPath}`);
	console.error(`  ${jsonPath}`);
}

// ponytail: main 只在直接执行时触发,被 test import 时不跑(共享 smoke-task.mjs 的守卫范式)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(`[eval] 失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
