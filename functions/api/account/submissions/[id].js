import { withdrawSubmission } from "../../../_lib/marketplace.js";

export async function onRequestDelete({ request, env, params }) {
	return withdrawSubmission(request, env, params.id);
}
