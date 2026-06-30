const SESSION_COOKIE = "ugk_session";
const OAUTH_STATE_COOKIE = "ugk_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function stringToBase64Url(value) {
	return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToString(value) {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function parseCookies(request) {
	const header = request.headers.get("cookie") ?? "";
	return Object.fromEntries(header.split(";").map((part) => {
		const [key, ...rest] = part.trim().split("=");
		return [key, rest.join("=")];
	}).filter(([key]) => key));
}

function json(data, init = {}) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init.headers ?? {}),
		},
	});
}

function htmlError(message, status = 400) {
	return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function signature(data, secret) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

function sameSignature(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

export async function createSessionCookie(user, env) {
	const now = Math.floor(Date.now() / 1000);
	const payload = stringToBase64Url(JSON.stringify({ id: user.id, login: user.login, iat: now, exp: now + SESSION_MAX_AGE }));
	const sig = await signature(payload, env.SESSION_SECRET);
	return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

async function readSession(request, env) {
	const value = parseCookies(request)[SESSION_COOKIE];
	if (!value || !env.SESSION_SECRET) return null;
	const [payload, sig] = value.split(".");
	if (!payload || !sig || !sameSignature(sig, await signature(payload, env.SESSION_SECRET))) return null;
	const session = JSON.parse(base64UrlToString(payload));
	if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
	return session;
}

async function sessionUser(request, env) {
	const session = await readSession(request, env);
	if (!session) return null;
	return await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.id).first();
}

async function ensureTask(env, name) {
	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT OR IGNORE INTO tasks (name, title, description, author_name, created_at) VALUES (?, ?, ?, ?, ?)",
	).bind(name, name, "", "UGK Official", now).run();
}

async function taskCounts(env, name) {
	const row = await env.DB.prepare("SELECT download_count, like_count, favorite_count FROM tasks WHERE name = ?").bind(name).first();
	return {
		downloads: row?.download_count ?? 0,
		likes: row?.like_count ?? 0,
		favorites: row?.favorite_count ?? 0,
	};
}

async function taskFlags(env, user, name) {
	if (!user) return { liked: false, favorited: false };
	const liked = await env.DB.prepare("SELECT 1 FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, user.id).first();
	const favorited = await env.DB.prepare("SELECT 1 FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, user.id).first();
	return { liked: Boolean(liked), favorited: Boolean(favorited) };
}

export async function githubLogin(request, env, deps = {}) {
	if (!env.GITHUB_CLIENT_ID) {
		return json({ error: "GitHub OAuth is not configured" }, { status: 500 });
	}

	const state = deps.randomUUID?.() ?? crypto.randomUUID();
	const url = new URL("https://github.com/login/oauth/authorize");
	const origin = env.SITE_URL ?? new URL(request.url).origin;
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
	url.searchParams.set("scope", "read:user");
	url.searchParams.set("state", state);
	return new Response(null, {
		status: 302,
		headers: {
			location: url.href,
			"set-cookie": `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
		},
	});
}

export async function githubCallback(request, env, deps = {}) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const cookieState = parseCookies(request)[OAUTH_STATE_COOKIE];
	if (!state || !cookieState || state !== cookieState) return htmlError("Invalid OAuth state", 400);
	if (!code) return htmlError("Missing OAuth code", 400);
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return htmlError("GitHub OAuth is not configured", 500);

	const origin = env.SITE_URL ?? url.origin;
	const fetchFn = deps.fetch ?? fetch;
	const tokenResponse = await fetchFn("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${origin}/api/auth/callback`,
		}),
	});
	const token = await tokenResponse.json();
	if (!token.access_token) return htmlError("GitHub token exchange failed", 502);

	const userResponse = await fetchFn("https://api.github.com/user", {
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token.access_token}`,
			"user-agent": "ugk-task-share",
		},
	});
	const githubUser = await userResponse.json();
	if (!githubUser.id || !githubUser.login) return htmlError("GitHub user fetch failed", 502);

	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url",
	).bind(String(githubUser.id), githubUser.login, githubUser.avatar_url ?? "", now).run();
	const user = await env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(String(githubUser.id)).first();
	const headers = new Headers({ location: "/" });
	headers.append("set-cookie", await createSessionCookie(user, env));
	headers.append("set-cookie", `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
	return new Response(null, { status: 302, headers });
}

export async function currentSession(request, env) {
	const user = await sessionUser(request, env);
	return json({ user: user ? { id: user.id, login: user.login, avatarUrl: user.avatar_url } : null });
}

export async function accountFavorites(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT tasks.name, tasks.title, tasks.description, tasks.author_name, tasks.download_count, tasks.like_count, tasks.favorite_count
		FROM task_favorites
		JOIN tasks ON tasks.name = task_favorites.task_name
		WHERE task_favorites.user_id = ?
		ORDER BY task_favorites.created_at DESC`,
	).bind(auth.user.id).all();
	return json({ favorites: rows.results ?? [] });
}

export function logout() {
	return new Response(null, {
		status: 204,
		headers: { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
	});
}

async function requireUser(request, env) {
	const user = await sessionUser(request, env);
	if (!user) return { response: json({ error: "login_required" }, { status: 401 }) };
	return { user };
}

export async function toggleLike(request, env, name) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	await ensureTask(env, name);
	const existing = await env.DB.prepare("SELECT 1 FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).first();
	if (existing) {
		await env.DB.prepare("DELETE FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).run();
		await env.DB.prepare("UPDATE tasks SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE name = ?").bind(name).run();
	} else {
		await env.DB.prepare("INSERT INTO task_likes (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, auth.user.id, new Date().toISOString()).run();
		await env.DB.prepare("UPDATE tasks SET like_count = like_count + 1 WHERE name = ?").bind(name).run();
	}
	return json({ liked: !existing, ...(await taskCounts(env, name)) });
}

export async function toggleFavorite(request, env, name) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	await ensureTask(env, name);
	const existing = await env.DB.prepare("SELECT 1 FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).first();
	if (existing) {
		await env.DB.prepare("DELETE FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).run();
		await env.DB.prepare("UPDATE tasks SET favorite_count = CASE WHEN favorite_count > 0 THEN favorite_count - 1 ELSE 0 END WHERE name = ?").bind(name).run();
	} else {
		await env.DB.prepare("INSERT INTO task_favorites (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, auth.user.id, new Date().toISOString()).run();
		await env.DB.prepare("UPDATE tasks SET favorite_count = favorite_count + 1 WHERE name = ?").bind(name).run();
	}
	return json({ favorited: !existing, ...(await taskCounts(env, name)) });
}

export async function getTaskStats(request, env, name) {
	await ensureTask(env, name);
	const user = await sessionUser(request, env);
	return json({ ...(await taskCounts(env, name)), ...(await taskFlags(env, user, name)) });
}

export async function recordDownload(request, env, name) {
	const user = await sessionUser(request, env);
	await ensureTask(env, name);
	await env.DB.prepare("INSERT INTO download_events (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, user?.id ?? null, new Date().toISOString()).run();
	await env.DB.prepare("UPDATE tasks SET download_count = download_count + 1 WHERE name = ?").bind(name).run();
	return json(await taskCounts(env, name));
}
