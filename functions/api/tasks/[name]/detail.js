import { taskPublicDetail } from "../../../_lib/marketplace.js";

export async function onRequestGet({ env, params }) {
	return taskPublicDetail(env, params.name);
}
