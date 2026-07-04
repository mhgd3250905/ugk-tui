/**
 * 按 contextWindow 分档的压缩触发阈值。
 * 小窗晚压防丢上下文,大窗早压省 token。
 */

export interface CompactionThreshold {
	readonly ratio: number;
	readonly tier: "small" | "medium" | "large";
}

const FALLBACK_THRESHOLD: CompactionThreshold = { ratio: 0.7, tier: "medium" };

const TIERS: ReadonlyArray<{ maxWindow: number; threshold: CompactionThreshold }> = [
	{ maxWindow: 200_000, threshold: { ratio: 0.75, tier: "small" } },
	{ maxWindow: 500_000, threshold: FALLBACK_THRESHOLD },
	{ maxWindow: Infinity, threshold: { ratio: 0.6, tier: "large" } },
];

export function getThreshold(contextWindow: number | undefined | null): CompactionThreshold {
	if (!contextWindow || contextWindow <= 0) return FALLBACK_THRESHOLD;
	return TIERS.find((tier) => contextWindow <= tier.maxWindow)?.threshold ?? FALLBACK_THRESHOLD;
}

export function getThresholdTokens(contextWindow: number | undefined | null): number {
	return Math.floor((contextWindow ?? 0) * getThreshold(contextWindow).ratio);
}
