function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerifyFailure(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.assertion === "string" &&
		typeof value.expected === "string" &&
		typeof value.actual === "string" &&
		(value.hint === undefined || typeof value.hint === "string")
	);
}

function isTaskRun(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.timestamp === "string" &&
		(value.status === "pass" || value.status === "fail") &&
		typeof value.exitCode === "number" &&
		Array.isArray(value.verifyFailures) &&
		value.verifyFailures.every(isVerifyFailure) &&
		typeof value.duration === "number" &&
		Object.hasOwn(value, "input")
	);
}

export function isTaskbook(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		(value.scope === "user" || value.scope === "project") &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.tags === undefined || isStringArray(value.tags)) &&
		Array.isArray(value.runs) &&
		value.runs.every(isTaskRun)
	);
}

export function isRequirementsSpec(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.goal === "string" &&
		value.goal.trim().length > 0 &&
		isStringArray(value.hardConstraints) &&
		value.hardConstraints.length > 0 &&
		isStringArray(value.acceptance) &&
		value.acceptance.length > 0 &&
		(value.forbidden === undefined || isStringArray(value.forbidden)) &&
		(value.context === undefined || typeof value.context === "string")
	);
}

export function assertValidContract(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Invalid contract.json");
	if (contract.runtimeInput !== undefined && !isStringArray(contract.runtimeInput)) throw new Error("Invalid contract.runtimeInput");
	if (contract.requiredEnv !== undefined && !isStringArray(contract.requiredEnv)) throw new Error("Invalid contract.requiredEnv");
	if (contract.requiredTools !== undefined && !isStringArray(contract.requiredTools)) throw new Error("Invalid contract.requiredTools");
	if (contract.requiredBinaries !== undefined && !isStringArray(contract.requiredBinaries)) throw new Error("Invalid contract.requiredBinaries");
	if (contract.maxRetry !== undefined && (!Number.isInteger(contract.maxRetry) || contract.maxRetry < 0)) throw new Error("Invalid contract.maxRetry");
	if (contract.runtimeInputMeta === undefined) return;
	if (!contract.runtimeInputMeta || typeof contract.runtimeInputMeta !== "object" || Array.isArray(contract.runtimeInputMeta)) {
		throw new Error("Invalid contract.runtimeInputMeta");
	}
	const fields = new Set(isStringArray(contract.runtimeInput) ? contract.runtimeInput : []);
	for (const [field, meta] of Object.entries(contract.runtimeInputMeta)) {
		if (!fields.has(field)) throw new Error(`Invalid contract.runtimeInputMeta: "${field}" is not declared in runtimeInput`);
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`Invalid contract.runtimeInputMeta.${field}`);
	}
}
