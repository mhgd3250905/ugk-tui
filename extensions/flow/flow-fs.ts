import { readFileSync } from "node:fs";

/**
 * Flow 模块共享的 JSON/记录读取原语。
 *
 * 设计取舍:Flow 各 store 之前各自复制了 readJsonFile(= JSON.parse(readFileSync))
 * 与 isRecord,但吞错口径不一(task-store/run-validation 抛错、review-store/driver-store
 * 吞错返回 undefined、校验场景 push issue)。这里只提供"读取+解析"这一层原语,把"如何
 * 处理失败"留给调用方,从而消除重复但不抹平各场景本应有的错误语义。
 *
 * - {@link isRecord}:类型守卫,判断值是否为非数组的普通对象。
 * - {@link readJsonStrict}:解析并返回;文件缺失或 JSON 非法时抛错。调用方自行 try/catch
 *   或先用 existsSync 判定。匹配 task-store/run-validation/task-validation 的现有策略
 *   (损坏→抛错,缺失→外层 existsSync 走 undefined 或 issue 分支)。
 * - {@link readJsonOptional}:文件缺失或 JSON 非法一律返回 undefined。覆盖"查询场景"
 *   (读不到视为无记录)与 review-store/driver-store 的实际用法。
 * - {@link readJsonRecord}:{@link readJsonOptional} + {@link isRecord} 二合一,
 *   直接给"读出来要是对象"的最常见形态。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonStrict(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readJsonOptional(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
	const parsed = readJsonOptional(filePath);
	return isRecord(parsed) ? parsed : undefined;
}
