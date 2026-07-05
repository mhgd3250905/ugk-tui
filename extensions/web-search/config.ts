export type SearchEngine = "google" | "bing";

export const ALLOWED_HOSTS = new Set([
	"www.google.com",
	"www.google.com.hk",
	"cn.bing.com",
	"www.bing.com",
]);

export function buildSearchUrl(query: string, engine: SearchEngine): string {
	const q = encodeURIComponent(query.trim());
	if (engine === "google") return `https://www.google.com/search?q=${q}&hl=zh-CN`;
	return `https://cn.bing.com/search?q=${q}&setlang=zh-CN`;
}

export function validateSearchUrl(url: string): { ok: true; host: string } | { ok: false; reason: string } {
	try {
		const parsed = new URL(url);
		if (ALLOWED_HOSTS.has(parsed.hostname)) return { ok: true, host: parsed.hostname };
		return { ok: false, reason: `host ${parsed.hostname} 不在白名单` };
	} catch {
		return { ok: false, reason: "URL 解析失败" };
	}
}

export function detectFailure(text: string): { failed: boolean; reason?: string } {
	const signals = [
		/unusual traffic/i,
		/are you a robot/i,
		/我们的系统检测到.*异常流量/,
		/请输入验证码/,
		/\/sorry\/index/i,
		/this site can.?t be reached/i,
		/无法访问此网站/,
		/ERR_[A-Z0-9_]+/,
	];
	for (const signal of signals) {
		if (signal.test(text)) return { failed: true, reason: `命中反爬信号: ${signal.source}` };
	}
	return { failed: false };
}

export function truncateContent(text: string, maxBytes = 8192): { text: string; truncated: boolean; bytes: number } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, truncated: false, bytes };
	const suffix = "\n...(已截断)";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const cutBytes = Math.max(0, maxBytes - suffixBytes);
	let cut = Buffer.from(text, "utf8").subarray(0, cutBytes).toString("utf8").replace(/\uFFFD+$/u, "");
	while (Buffer.byteLength(cut + suffix, "utf8") > maxBytes) cut = cut.slice(0, -1);
	return {
		text: cut + suffix,
		truncated: true,
		bytes,
	};
}
