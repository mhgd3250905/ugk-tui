/**
 * TUI 上传 taskbook 到市场(打包 + Bearer 上传)。
 *
 * 设计见 docs/design/2026-07-01-task-publish-from-tui.md §6.5。
 * 读 LoadedTaskbook 5 个核心文件 → 清空 runs 历史 → zip → multipart 上传。
 * 认证由 task-share-auth.ts 的 task-share.json (cli_token) 提供。
 *
 * scripts/ 子目录本轮不传(YAGNI,文档 §2 决策⑥)。
 */

import { zipSync } from "fflate";
import type { LoadedTaskbook } from "./task-book.ts";

/** 可注入依赖(便于单测)。 */
export interface TaskSharePublishDeps {
	fetchFn?: typeof fetch;
}

export interface PublishResult {
	ok: true;
	name: string;
	version: string;
}

/**
 * 从 LoadedTaskbook 构造上传用 zip。
 * 关键:taskbook.json 的 runs 历史必须清空(文档 §6.5 注 + §10 风险②),
 * 避免把本地运行记录传到市场。
 */
export function buildTaskZip(loaded: LoadedTaskbook): Uint8Array {
	// 浅拷贝 taskbook 并清空 runs,不动原对象(它可能仍在内存被其他逻辑用)。
	const taskbookSanitized = { ...loaded.taskbook, runs: [] };
	const files: Record<string, Uint8Array> = {
		"taskbook.json": new TextEncoder().encode(JSON.stringify(taskbookSanitized, null, "\t") + "\n"),
		"spec.json": new TextEncoder().encode(JSON.stringify(loaded.spec, null, "\t") + "\n"),
		"contract.json": new TextEncoder().encode(JSON.stringify(loaded.contract, null, "\t") + "\n"),
		"skill.md": new TextEncoder().encode(loaded.skill),
		"verify.mjs": new TextEncoder().encode(loaded.verify),
	};
	return zipSync(files);
}

/**
 * 打包并上传 taskbook 到市场。
 * @param title 自定义标题(市场卡片用);空则回退 taskbook.name。
 * @param description 自定义一句话描述(市场卡片用);空则回退 taskbook.description。
 *   两者分离是因为 taskbook.description 是给 agent 的运行指令(常很长),
 *   不适合市场卡片给人看的简短文案。
 * @throws Error 上传失败(网络/鉴权/校验)。
 */
export async function publishTask(
	loaded: LoadedTaskbook,
	version: string,
	token: string,
	marketplaceUrl: string,
	title: string | undefined,
	description: string | undefined,
	deps: TaskSharePublishDeps = {},
): Promise<PublishResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const zip = buildTaskZip(loaded);
	const name = loaded.taskbook.name;

	const form = new FormData();
	form.set("name", name);
	form.set("version", version);
	form.set("title", title || name);
	form.set("description", description || loaded.taskbook.description);
	form.set("artifact", new File([zip as BlobPart], `${name}-${version}.zip`, { type: "application/zip" }));

	const res = await fetchFn(`${marketplaceUrl}/api/tasks/submit`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: form,
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
		throw new Error(`上传失败:${detail}`);
	}
	return { ok: true, name, version };
}
