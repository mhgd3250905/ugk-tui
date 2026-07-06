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
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { complete } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildTaskDispatcherPrompt, extractRuntimeInputFromText } from "../extensions/task/task-dispatcher.ts";
// ponytail: 评判器抽到引擎侧共享模块,切断"引擎单测 → import 会读 fixture 的 runner"耦合。
// runner 和单测都从这里 import;评判逻辑零行为变化(现有单测保护)。
import { judgeField, judgeCase } from "../extensions/task/task-eval-judge.ts";

// re-export 保持向后兼容(若有外部代码仍从 eval-dispatcher 拿评判器)
export { judgeField, judgeCase };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyFixturesTaskbooksDir = path.join(root, "tests", "fixtures", "taskbooks");
const legacyFixturesEvalsDir = path.join(root, "tests", "fixtures", "dispatcher-evals");

// ponytail: task 包结构闭环 —— eval cases 现在随 task 包走,落在 <taskDir>/<name>/tests/eval.cases.json。
// runner 按 --task=<name> 解析已安装 task 包(user scope 优先,project scope 兜底);
// --legacy-fixtures flag 仅迁移期用,回退到老 tests/fixtures/ 路径。
function tasksRootUser() {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "tasks");
}
function tasksRootProject(cwd) {
	return path.join(cwd, ".tasks");
}
/**
 * 按 name 解析 task 包目录:user scope → project scope(cwd)→ legacy fixtures(--legacy-fixtures 时)。
 * 找不到返回 null,调用方报清晰错误。
 */
function resolveTaskDir(name, opts) {
	const candidates = [
		path.join(tasksRootUser(), name),
		path.join(tasksRootProject(process.cwd()), name),
	];
	if (opts.legacyFixtures) candidates.push(path.join(legacyFixturesTaskbooksDir, name));
	for (const dir of candidates) {
		if (existsSync(path.join(dir, "contract.json"))) return dir;
	}
	return null;
}
/**
 * 解析 eval cases 路径:优先包内 tests/eval.cases.json;--legacy-fixtures 时回退到老 dispatcher-evals/。
 * 返回 { casesPath, reportBase } —— reportBase 是报告输出前缀(随包走或随老位置走)。
 */
function resolveEvalPaths(name, taskDir, opts) {
	if (opts.legacyFixtures) {
		return {
			casesPath: path.join(legacyFixturesEvalsDir, `${name}.cases.json`),
			reportBase: legacyFixturesEvalsDir,
			reportPrefix: name,
		};
	}
	return {
		casesPath: path.join(taskDir, "tests", "eval.cases.json"),
		reportBase: path.join(taskDir, "tests"),
		reportPrefix: "eval",
	};
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
		// ponytail: 迁移期 flag,回退读老 tests/fixtures/ 路径。迁完所有 task 后删除。
		else if (a === "--legacy-fixtures") args.legacyFixtures = true;
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
		console.error("用法: node scripts/eval-dispatcher.mjs --task=<name> [--model=provider/modelId] [--legacy-fixtures]");
		console.error("  --task          已安装的 taskbook 名(user scope 优先,project scope 兜底)");
		console.error("  --model         provider/modelId,如 deepseek/deepseek-chat。省略取首个可用 model");
		console.error("  --legacy-fixtures  迁移期:回退读 tests/fixtures/ 老路径(task 迁完删除)");
		process.exit(1);
	}
	const taskName = args.task;
	const opts = { legacyFixtures: !!args.legacyFixtures };
	// ponytail: task 包结构闭环 —— contract/skill 从 task 包根读,cases 从包内 tests/ 读。
	const taskDir = resolveTaskDir(taskName, opts);
	if (!taskDir) {
		const where = opts.legacyFixtures
			? `user/project scope 或 ${legacyFixturesTaskbooksDir}`
			: `user scope(${tasksRootUser()})或 project scope(${tasksRootProject(process.cwd())})`;
		throw new Error(`找不到 task "${taskName}" 的包目录(查找:${where})。确认已安装,或用 --legacy-fixtures 读老 fixture。`);
	}
	const contractPath = path.join(taskDir, "contract.json");
	const skillPath = path.join(taskDir, "skill.md");
	const { casesPath, reportBase, reportPrefix } = resolveEvalPaths(taskName, taskDir, opts);
	if (!existsSync(casesPath)) {
		throw new Error(`task "${taskName}" 未自带 eval 用例: ${casesPath}\n该 task 包内没有 tests/eval.cases.json。若用老 fixture,加 --legacy-fixtures。`);
	}

	const contract = JSON.parse(await readFile(contractPath, "utf8"));
	const skill = await readFile(skillPath, "utf8");
	const casesFile = JSON.parse(await readFile(casesPath, "utf8"));
	const cases = Array.isArray(casesFile.cases) ? casesFile.cases : [];

	console.error(`[eval] task=${taskName} 包=${taskDir} cases=${cases.length} 解析 model...`);
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
	// ponytail: 报告随包走,写到 task 包内 tests/ 下(gitignore);legacy 模式回退到老 dispatcher-evals/。
	const { mkdir } = await import("node:fs/promises");
	await mkdir(reportBase, { recursive: true });
	const jsonPath = path.join(reportBase, `${reportPrefix}.report.json`);
	const mdPath = path.join(reportBase, `${reportPrefix}.report.md`);
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
