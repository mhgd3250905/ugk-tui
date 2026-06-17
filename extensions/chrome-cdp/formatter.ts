import type { ChromeCdpStatus, ChromeTab } from "./client.ts";

export function formatChromeTabs(tabs: ChromeTab[]): string {
	if (!tabs.length) return "No Chrome page tabs found.";
	return tabs
		.map((tab, index) => `${index + 1}. ${tab.id}  ${tab.title || "(untitled)"}\n   ${tab.url || "about:blank"}`)
		.join("\n");
}

export function formatChromeCdpStatus(status: ChromeCdpStatus): string {
	if (!status.online) {
		return `🌐 Chrome CDP\n⚠️ 127.0.0.1:${status.port} not reachable\n${status.error || "Connection failed"}`;
	}
	return `🌐 Chrome CDP\n✅ 127.0.0.1:${status.port} online\nTabs: ${status.tabs?.length ?? 0}`;
}
