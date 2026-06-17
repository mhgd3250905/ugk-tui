export function applyUgkRuntimePolicy(env = process.env) {
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
}
