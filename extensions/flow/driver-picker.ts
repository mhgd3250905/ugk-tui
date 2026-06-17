import type { FlowDriverSummary } from "./types.ts";

function formatRelativeAge(updatedAt: string | undefined, now: Date): string {
	if (!updatedAt) {
		return "unknown";
	}

	const updatedTime = new Date(updatedAt).getTime();
	const nowTime = now.getTime();
	if (!Number.isFinite(updatedTime) || !Number.isFinite(nowTime)) {
		return "unknown";
	}

	const seconds = Math.max(0, Math.floor((nowTime - updatedTime) / 1000));
	if (seconds < 60) {
		return `${seconds}s ago`;
	}

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	return `${Math.floor(minutes / 60)}h ago`;
}

export function formatDriverPickerOption(driver: FlowDriverSummary, now = new Date()): string {
	const id = `${driver.taskId}/${driver.runId}`;
	return [
		driver.status,
		id,
		driver.step ?? "-",
		driver.summary ?? "-",
		formatRelativeAge(driver.updatedAt, now),
	].join("  ");
}

export function getDriverPickerOptions(drivers: FlowDriverSummary[], now = new Date()): string[] {
	return drivers.map((driver) => formatDriverPickerOption(driver, now));
}

export function parseDriverPickerSelection(
	selection: string | undefined,
	drivers: FlowDriverSummary[],
	now = new Date(),
): FlowDriverSummary | undefined {
	if (!selection) {
		return undefined;
	}

	return drivers.find((driver) => formatDriverPickerOption(driver, now) === selection);
}
