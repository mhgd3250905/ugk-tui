// dispatcher eval 通用评判器(纯函数)。
// ponytail: 原本内联在 scripts/eval-dispatcher.mjs,被 tests/task-dispatcher-eval.test.ts import。
// 抽到这个引擎侧共享模块,切断"引擎单测 → import 一个会读 fixture 路径的 runner 脚本"的间接耦合。
// runner 和单测都从这里 import;评判逻辑零行为变化(有现有单测保护)。
//
// rule 格式:"equals:<值>" | "path-equals:<值>" | "omitted" | "absent" | "present" | "in:a|b|c"
// __outcome 特殊字段(整体结果断言):"fails-required-gate"

export interface JudgeFieldInput {
	/** 实际字段值(字段不存在时传 undefined) */
	actualValue: unknown;
	/** 字段是否存在于输出对象(hasOwnProperty) */
	hasField: boolean;
	/** 规则字符串,如 "equals:en" / "omitted" / "in:a|b" */
	rule: string;
}

export interface JudgeResult {
	ok: boolean;
	detail: string;
}

export interface JudgeCaseResult {
	ok: boolean;
	fieldResults: Array<{ field: string; rule: string; ok: boolean; detail: string }>;
	detail: string;
}

function ruleParts(rule: string): { op: string; arg: string | undefined } {
	const idx = rule.indexOf(":");
	return idx >= 0 ? { op: rule.slice(0, idx), arg: rule.slice(idx + 1) } : { op: rule, arg: undefined };
}

function isPresentValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value as object).length > 0;
	return false;
}

export function judgeField(actualValue: unknown, hasField: boolean, rule: string): JudgeResult {
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

/**
 * 整体结果评判。支持 __outcome 特殊字段(如 "fails-required-gate")做整体结果断言。
 * assertSpec 的其它键是字段级规则。
 */
export function judgeCase(actualOutput: unknown, parsedOk: boolean, assertSpec: Record<string, string>): JudgeCaseResult {
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

	const output = actualOutput && typeof actualOutput === "object" && !Array.isArray(actualOutput) ? actualOutput as Record<string, unknown> : {};
	const fieldResults: JudgeCaseResult["fieldResults"] = [];
	let allOk = parsedOk; // dispatcher 没解析出 = 整体失败(除非 __outcome)
	for (const [field, rule] of Object.entries(assertSpec)) {
		const hasField = Object.prototype.hasOwnProperty.call(output, field);
		const result = judgeField(output[field], hasField, rule);
		fieldResults.push({ field, rule, ...result });
		if (!result.ok) allOk = false;
	}
	return { ok: allOk, fieldResults, detail: allOk ? "全部字段通过" : "存在失败字段" };
}
