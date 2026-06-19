import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Flow 判定记录签名基础设施。
 *
 * 设计目标:让 agent 伪造不了"已被 runtime 接受"这个事实。判定记录(task 状态、
 * review、validation)的关键字段带 HMAC 签名;签名密钥从 ~/.flow-master-key 派生,
 * 不在 .flow/ 里,agent 工作区碰不到。
 *
 * 安全要点(见 docs/design/2026-06-18-flow-signed-records-design.md):
 * - 反馈绝不向 agent 暴露签名机制——验签结果用中性枚举(verified/broken),调用方
 *   用中性措辞反馈("记录不可用"),不提签名/密钥/HMAC。
 * - canonicalJSON 保证确定性:同字段值永远同签名,字段顺序无关。
 *
 * 本模块只管签名原语。哪些字段签、何时签、何时验、损坏怎么反馈,由调用方(task-state /
 * review-store / run-validation)按设计文档执行。
 */

const MASTER_KEY_PATH = path.join(homedir(), ".flow-master-key");
const SIGNING_INFO = "flow-task-signing";
const KEY_LEN = 32;
const MASTER_KEY_PERMS = 0o600;

/**
 * 判定记录的签名载荷。附在 JSON 文件里,字段名用 _sig——不加密、不隐藏,但 agent
 * 没有密钥就算不出正确的 value。
 */
export interface RecordSignature {
	alg: "hmac-sha256";
	/** 被签名的字段名列表。验签时按此取字段,防"加了字段没签"的漏签。 */
	covered: readonly string[];
	/** HMAC-SHA256(projectKey, canonicalJSON(coveredFields)) 的 base64。 */
	value: string;
	/** runtime 签名的时间(ISO),用于内部诊断,不暴露给 agent。 */
	signedAt: string;
}

/**
 * 验签结果。刻意用中性命名:verified = 可信;broken = 不可信(无论原因是被篡改、
 * 无签名、还是格式错)。调用方对 broken 的反馈必须用中性措辞,不提签名机制。
 */
export type SignatureCheck = { verified: true } | { verified: false; reason: "no-signature" | "mismatch" | "malformed" };

/** 项目上下文:master key 派生 project key 用。cwd 决定派生 salt。 */
export interface ProjectSigningContext {
	cwd: string;
}

// ---- 密钥管理 ----

/**
 * 读取或生成主密钥(~/.flow-master-key)。首次调用时生成,权限限当前用户。
 * 主密钥丢失不可恢复(见设计第七节);用户需 /flow reset-signing 重新信任记录。
 */
export function getOrCreateMasterKey(): Buffer {
	if (existsSync(MASTER_KEY_PATH)) {
		return Buffer.from(readFileSync(MASTER_KEY_PATH, "utf8").trim(), "base64");
	}
	const key = randomBytes(KEY_LEN);
	mkdirSync(path.dirname(MASTER_KEY_PATH), { recursive: true });
	writeFileSync(MASTER_KEY_PATH, key.toString("base64"));
	try {
		chmodSync(MASTER_KEY_PATH, MASTER_KEY_PERMS);
	} catch {
		// Windows/某些文件系统 chmod 可能受限;尽力而为,不阻断。
	}
	return key;
}

/**
 * 派生项目密钥。同主密钥 + 同 cwd → 同项目密钥(确定性)。cwd 变化 → 密钥变化 →
 * 旧签名失效 → 触发首次重签(设计第八节)。
 */
export function deriveProjectKey(ctx: ProjectSigningContext, masterKey?: Buffer): Buffer {
	const master = masterKey ?? getOrCreateMasterKey();
	const cwdSalt = path.resolve(ctx.cwd);
	const derived = hkdfSync("sha256", master, cwdSalt, SIGNING_INFO, KEY_LEN);
	return Buffer.from(derived);
}

// ---- 签名与验签 ----

/**
 * canonical JSON:对象 key 按 ASCII 排序,确定性序列化。保证同字段值永远同签名。
 * 嵌套对象递归排序;数组保持原序(数组是有序集合)。
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * 从记录里取出要签的字段,算签名值。
 * covered 里列出的字段缺失时按 null 签(防"删字段绕过签名")。
 */
function extractCovered(record: Record<string, unknown>, covered: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of covered) {
		// undefined 和缺失统一当 null,避免"签时 undefined、验时缺失"的不一致
		// (JSON.stringify 会省略 undefined,导致落盘后字段消失,验签时 key 不在)。
		const v = record[key];
		out[key] = v === undefined ? null : v;
	}
	return out;
}

function computeSignatureValue(projectKey: Buffer, covered: Record<string, unknown>): string {
	return createHmac("sha256", projectKey).update(canonicalJson(covered)).digest("base64");
}

/**
 * 为判定记录的关键字段生成签名。runtime 写判定记录时调用。
 * 返回的 _sig 附进 JSON 文件一起落盘。
 */
export function signRecord(
	projectKey: Buffer,
	record: Record<string, unknown>,
	covered: readonly string[],
	now = new Date(),
): RecordSignature {
	const coveredFields = extractCovered(record, covered);
	return {
		alg: "hmac-sha256",
		covered,
		value: computeSignatureValue(projectKey, coveredFields),
		signedAt: now.toISOString(),
	};
}

/**
 * 验证判定记录的签名。runtime 每次读判定记录时调用。
 *
 * 返回中性结果:verified(可信)或 broken(不可信)。调用方对 broken 的反馈
 * 必须遵守设计文档的反馈安全要求——中性措辞,不提签名/密钥。
 *
 * requiredCovered(可选):当前记录类型**必须**覆盖的判定字段集。传入时,校验记录
 * 自带的 _sig.covered 是否包含全部 requiredCovered——防止旧签名(covered 字段少)
 * 被用来给 agent 补写的新字段背书(如旧 review 不含 taskDesignDecision,agent 补写
 * 后验签仍过 → 绕过 isFlowReviewAccepted gate)。covered 不足返回 mismatch。
 */
export function verifyRecord(
	projectKey: Buffer,
	record: Record<string, unknown>,
	requiredCovered?: readonly string[],
): SignatureCheck {
	// 区分"完全没有 _sig 字段"(no-signature,旧版数据,可补签)vs
	// "_sig 字段存在但值非法"(malformed,被篡改/损坏,不可自动补签洗白)。
	// _sig: null/0/""/false 等都属于 malformed——字段在但不是合法签名对象。
	if (!Object.prototype.hasOwnProperty.call(record, "_sig")) {
		return { verified: false, reason: "no-signature" };
	}
	const sig = record["_sig"];
	if (!sig || typeof sig !== "object") {
		return { verified: false, reason: "malformed" };
	}
	const sigObj = sig as Partial<RecordSignature>;
	if (!Array.isArray(sigObj.covered) || typeof sigObj.value !== "string") {
		return { verified: false, reason: "malformed" };
	}
	// covered 完整性:记录自带 covered 必须包含当前类型应有的全部判定字段。
	// 旧签名(字段集小)不能给新字段背书——缺字段 = 不可信(mismatch)。
	if (requiredCovered && !requiredCovered.every((field) => (sigObj.covered as string[]).includes(field))) {
		return { verified: false, reason: "mismatch" };
	}
	const coveredFields = extractCovered(record, sigObj.covered);
	const expected = computeSignatureValue(projectKey, coveredFields);
	// 常量时间比较,防时序攻击(虽然威胁模型里 agent 不太可能,但密码学基本功)。
	const expectedBuf = Buffer.from(expected);
	const actualBuf = Buffer.from(sigObj.value);
	if (expectedBuf.length !== actualBuf.length) {
		return { verified: false, reason: "mismatch" };
	}
	if (!timingSafeEqual(expectedBuf, actualBuf)) {
		return { verified: false, reason: "mismatch" };
	}
	return { verified: true };
}

/**
 * 各判定记录被签名覆盖的字段名。集中定义一处,所有写/读/重签路径共用——
 * 防止"改了 task-store 忘改 flow-resign"的漏签。
 *
 * 原则:凡 agent 能手写、且会误导 runtime 判断的字段,都必须在此列。
 * 非判定性的展示字段(如 summary、issues、decisions)不在此列——它们不影响
 * 状态机决策,且其上游结论(如 result/status)已签。
 */
export const TASK_SIGNED_FIELDS = [
	"id",
	"status",
	"version",
	"latest_review_run",
	"ready_origin",
	"next_step", // 被 activity card 读为"下一步建议",agent 手写会误导
] as const;

export const REVIEW_SIGNED_FIELDS = [
	"taskId",
	"runId",
	"status",
	"taskVersion",
	"acceptedAt",
	"taskDesignUpdated", // isFlowReviewAccepted 的 hasSettledTaskDesign 用它判定
	"taskDesignDecision",
] as const;

export const VALIDATION_SIGNED_FIELDS = [
	"taskId",
	"runId",
	"result",
	"scope",
	"createdAt",
] as const;

export const STATUS_SIGNED_FIELDS = [
	"taskId",
	"runId",
	"status", // driverLive / session_shutdown / picker 排序都依赖它
	"updatedAt", // 防回滚到旧状态
] as const;

/**
 * 标准损坏反馈文案。调用方在 agent 可见的反馈里用这些,**不自己编**——
 * 保证措辞统一、不泄露签名机制。每条都是中性"记录不可用"+ 安全恢复动作。
 */
export const CORRUPT_FEEDBACK = {
	taskStatus: (taskId: string, runId?: string) =>
		runId
			? `Flow task ${taskId} 的状态记录不可用(被手写或损坏)。推进状态的唯一合法路径是 /flow task accept ${runId}(runtime 会写入),不要手写 task.json。若记录已损坏到无法 accept,用 /flow repair-signing ${taskId} 恢复。`
			: `Flow task ${taskId} 的状态记录不可用(被手写或损坏)。状态记录由 runtime 独占写入,不要手写 task.json。用 /flow repair-signing ${taskId} 恢复,或从证明阶段重新开始(/flow task prove ${taskId})。`,
	review: (taskId: string, runId?: string) =>
		runId
			? `task ${taskId} 的复盘记录不可用(被手写或损坏)。复盘记录由 runtime 在 /flow task accept ${runId} 时写入,不要手写 review.json。`
			: `task ${taskId} 的复盘记录不可用(被手写或损坏)。复盘记录由 runtime 在 /flow task accept 时写入,不要手写 review.json。`,
	validation: (runId: string) =>
		`run ${runId} 的校验记录不可用(被手写或损坏)。校验记录由 runtime 重新校验产出时写入,不要手写 validation.json。`,
} as const;
