import type { FlowDriverStatus } from "./types.ts";

export interface FlowDriverBanner {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
}

let currentBanner: FlowDriverBanner | undefined;
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function formatFlowDriverBannerText(banner: FlowDriverBanner): string {
	return `FLOW DRIVER ACTIVE  ${banner.taskId}/${banner.runId}  ${banner.status}  /flow detach 返回 main`;
}

export function getFlowDriverBanner(): FlowDriverBanner | undefined {
	return currentBanner;
}

export function setFlowDriverBanner(banner: FlowDriverBanner): void {
	currentBanner = banner;
	notifyListeners();
}

export function clearFlowDriverBanner(): void {
	currentBanner = undefined;
	notifyListeners();
}

export function subscribeFlowDriverBanner(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
