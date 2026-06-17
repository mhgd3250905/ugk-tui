import type { ChromeCdpStatus, ChromeTab } from "./client.ts";
import { renderTerminalTable } from "../terminal-table.ts";

export function formatChromeTabs(tabs: ChromeTab[]): string {
	const rows = tabs.length
		? tabs.map((tab, index) => [`${index + 1}`, tab.id, tab.title || "(untitled)", tab.url || "about:blank"])
		: [["📭", "-", "No Chrome page tabs found.", "-"]];
	return ["🌐 Chrome tabs", "", renderTerminalTable(["#", "ID", "Title", "URL"], rows)].join("\n");
}

export function formatChromeCdpStatus(status: ChromeCdpStatus): string {
	if (!status.online) {
		const rows = [["⚠️", `127.0.0.1:${status.port}`, "not reachable", "0"]];
		rows.push(["↳", "error", status.error || "Connection failed", ""]);
		return ["🌐 Chrome CDP", "", renderTerminalTable(["状态", "地址", "连接", "页面"], rows)].join("\n");
	}
	return [
		"🌐 Chrome CDP",
		"",
		renderTerminalTable(["状态", "地址", "连接", "页面"], [["✅", `127.0.0.1:${status.port}`, "online", `${status.tabs?.length ?? 0}`]]),
	].join("\n");
}
