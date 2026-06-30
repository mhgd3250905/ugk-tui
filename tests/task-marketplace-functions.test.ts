import test from "node:test";
import assert from "node:assert/strict";
import {
	createSessionCookie,
	currentSession,
	githubCallback,
	githubLogin,
	marketplaceStats,
	getTaskStats,
	recordDownload,
	toggleFavorite,
	toggleLike,
} from "../functions/_lib/marketplace.js";

function createDb() {
	const users = new Map();
	const usersById = new Map();
	const tasks = new Map([["video-downloader", { download_count: 0, like_count: 0, favorite_count: 0 }]]);
	const likes = new Set();
	const favorites = new Set();
	let nextUserId = 1;
	return {
		prepare(sql) {
			return {
				values: [],
				bind(...values) {
					this.values = values;
					return this;
				},
				async first() {
					if (sql.startsWith("SELECT COUNT(*) AS task_count")) {
						let downloads = 0;
						let likes = 0;
						let favorites = 0;
						for (const task of tasks.values()) {
							downloads += task.download_count;
							likes += task.like_count;
							favorites += task.favorite_count;
						}
						return { task_count: tasks.size, download_count: downloads, like_count: likes, favorite_count: favorites };
					}
					if (sql.startsWith("SELECT * FROM users WHERE id = ?")) return usersById.get(this.values[0]) ?? null;
					if (sql.startsWith("SELECT * FROM users WHERE github_id = ?")) return users.get(String(this.values[0])) ?? null;
					if (sql.startsWith("SELECT 1 FROM task_likes")) return likes.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM task_favorites")) return favorites.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT download_count")) return tasks.get(this.values[0]) ?? null;
					throw new Error(`Unhandled first SQL: ${sql}`);
				},
				async run() {
					if (sql.startsWith("INSERT INTO users")) {
						const [githubId, login, avatarUrl, now] = this.values;
						let user = users.get(String(githubId));
						if (!user) {
							user = { id: nextUserId++, github_id: String(githubId), login, avatar_url: avatarUrl, created_at: now };
							users.set(String(githubId), user);
							usersById.set(user.id, user);
						} else {
							user.login = login;
							user.avatar_url = avatarUrl;
						}
						return { success: true };
					}
					if (sql.startsWith("INSERT OR IGNORE INTO tasks")) {
						const [name, title, description, authorName, now] = this.values;
						if (!tasks.has(name)) tasks.set(name, { title, description, author_name: authorName, created_at: now, download_count: 0, like_count: 0, favorite_count: 0 });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_likes")) {
						likes.add(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM task_likes")) {
						likes.delete(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_favorites")) {
						favorites.add(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM task_favorites")) {
						favorites.delete(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("UPDATE tasks SET like_count")) {
						tasks.get(this.values[0]).like_count = [...likes].filter((item) => item.startsWith(`${this.values[0]}:`)).length;
						return { success: true };
					}
					if (sql.startsWith("UPDATE tasks SET favorite_count")) {
						tasks.get(this.values[0]).favorite_count = [...favorites].filter((item) => item.startsWith(`${this.values[0]}:`)).length;
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO download_events")) return { success: true };
					if (sql.startsWith("UPDATE tasks SET download_count")) {
						tasks.get(this.values[0]).download_count++;
						return { success: true };
					}
					throw new Error(`Unhandled run SQL: ${sql}`);
				},
			};
		},
	};
}

function env() {
	return {
		DB: createDb(),
		GITHUB_CLIENT_ID: "client-id",
		GITHUB_CLIENT_SECRET: "client-secret",
		SESSION_SECRET: "test-secret",
		SITE_URL: "https://ugk-task-share.pages.dev",
	};
}

test("githubLogin redirects to GitHub and stores oauth state", async () => {
	const response = await githubLogin(new Request("https://ugk-task-share.pages.dev/api/auth/github"), env(), { randomUUID: () => "state-1" });

	assert.equal(response.status, 302);
	assert.match(response.headers.get("location"), /github\.com\/login\/oauth\/authorize/);
	assert.match(response.headers.get("set-cookie"), /ugk_oauth_state=state-1/);
});

test("githubLogin reports missing OAuth configuration", async () => {
	const testEnv = env();
	delete testEnv.GITHUB_CLIENT_ID;
	const response = await githubLogin(new Request("https://ugk-task-share.pages.dev/api/auth/github"), testEnv);
	const body = await response.json();

	assert.equal(response.status, 500);
	assert.match(body.error, /not configured/i);
});

test("githubCallback verifies state, upserts user, and sets a session", async () => {
	const response = await githubCallback(
		new Request("https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=state-1", {
			headers: { cookie: "ugk_oauth_state=state-1" },
		}),
		env(),
		{
			fetch: async (url) => {
				if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "https://avatar.test/u.png" }), { headers: { "content-type": "application/json" } });
			},
		},
	);

	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), "/");
	assert.match(response.headers.get("set-cookie"), /ugk_session=/);
});

test("githubCallback rejects mismatched state", async () => {
	const response = await githubCallback(
		new Request("https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=bad", {
			headers: { cookie: "ugk_oauth_state=state-1" },
		}),
		env(),
	);

	assert.equal(response.status, 400);
	assert.match(await response.text(), /state/i);
});

test("session endpoint returns the signed-in user", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const response = await currentSession(new Request("https://ugk-task-share.pages.dev/api/session", { headers: { cookie } }), testEnv);
	const body = await response.json();

	assert.equal(body.user.login, "octo");
});

test("like and favorite require login and toggle counts", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const request = new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST", headers: { cookie } });

	assert.equal((await toggleLike(new Request(request), testEnv, "video-downloader")).status, 200);
	assert.equal((await (await toggleLike(new Request(request), testEnv, "video-downloader")).json()).liked, false);

	const favorite = await toggleFavorite(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/favorite", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	assert.equal((await favorite.json()).favorited, true);

	const anonymous = await toggleLike(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST" }), testEnv, "video-downloader");
	assert.equal(anonymous.status, 401);
});

test("stats include live counts and signed-in user flags", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	await toggleLike(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	await toggleFavorite(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/favorite", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	const response = await getTaskStats(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/stats", { headers: { cookie } }), testEnv, "video-downloader");
	const body = await response.json();

	assert.equal(body.likes, 1);
	assert.equal(body.favorites, 1);
	assert.equal(body.liked, true);
	assert.equal(body.favorited, true);
});

test("download events work for anonymous users", async () => {
	const testEnv = env();
	const response = await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const body = await response.json();

	assert.equal(body.downloads, 1);
});

test("marketplace stats summarize live D1 counters", async () => {
	const testEnv = env();
	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const response = await marketplaceStats(testEnv);
	const body = await response.json();

	assert.deepEqual(body, { tasks: 1, downloads: 1, likes: 0, favorites: 0 });
});
