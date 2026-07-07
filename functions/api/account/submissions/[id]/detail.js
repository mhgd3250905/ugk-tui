import { accountSubmissionDetail, updateAccountSubmissionDetail } from "../../../../_lib/marketplace.js";

export async function onRequestGet({ request, env, params }) {
	return accountSubmissionDetail(request, env, params.id);
}

export async function onRequestPut({ request, env, params }) {
	return updateAccountSubmissionDetail(request, env, params.id);
}
