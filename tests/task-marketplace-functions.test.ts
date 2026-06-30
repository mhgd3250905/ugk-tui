import test from "node:test";
import assert from "node:assert/strict";
import {
	createSessionCookie,
	accountDownloads,
	accountSubmissions,
	adminSubmissions,
	adminReports,
	communityTasks,
	currentSession,
	githubCallback,
	githubLogin,
	marketplaceStats,
	getTaskStats,
	getTaskStatsDetail,
	getTaskVersions,
	recordDownload,
	reportTask,
	reviewSubmission,
	submitTask,
	toggleFavorite,
	toggleLike,
} from "../functions/_lib/marketplace.js";

function createDb() {
	const users = new Map();
	const usersById = new Map();
	const tasks = new Map([["video-downloader", { download_count: 0, like_count: 0, favorite_count: 0 }]]);
	const submissions = [];
	const versions = [];
	const downloads = [];
	const reports = [];
	const likes = new Set();
	const favorites = new Set();
	let nextUserId = 1;
	let nextSubmissionId = 1;
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
					if (sql.startsWith("SELECT task_submissions.*")) return submissions.find((item) => item.id === this.values[0]) ?? null;
					if (sql.startsWith("SELECT 1 FROM task_likes")) return likes.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM task_favorites")) return favorites.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM download_events")) return downloads.some((item) => item.task_name === this.values[0] && item.user_id === this.values[1]) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM task_reports")) return reports.some((item) => item.task_name === this.values[0] && item.user_id === this.values[1]) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT download_count")) return tasks.get(this.values[0]) ?? null;
					throw new Error(`Unhandled first SQL: ${sql}`);
				},
				async all() {
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.user_id")) return { results: submissions.filter((item) => item.user_id === this.values[0]) };
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.status = 'pending'")) return { results: submissions.filter((item) => item.status === "pending") };
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.status = 'published'")) return { results: submissions.filter((item) => item.status === "published") };
					if (sql.includes("FROM download_events") && sql.includes("WHERE download_events.user_id")) {
						return { results: downloads.filter((item) => item.user_id === this.values[0]).map((item) => ({ ...item, ...(tasks.get(item.task_name) ?? {}), name: item.task_name })) };
					}
					if (sql.includes("FROM download_events") && sql.includes("WHERE task_name = ?")) {
						const counts = new Map();
						for (const item of downloads.filter((download) => download.task_name === this.values[0])) {
							const day = item.created_at.slice(0, 10);
							counts.set(day, (counts.get(day) ?? 0) + 1);
						}
						return { results: [...counts].map(([day, download_count]) => ({ day, download_count })) };
					}
					if (sql.includes("FROM task_versions")) return { results: versions.filter((item) => item.task_name === this.values[0]) };
					if (sql.includes("FROM task_reports")) return { results: reports.map((item) => ({ ...item, reporter_login: usersById.get(item.user_id)?.login ?? "unknown" })) };
					throw new Error(`Unhandled all SQL: ${sql}`);
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
					if (sql.startsWith("INSERT INTO task_submissions")) {
						const [userId, name, title, description, sourceType, sourceUrl, artifactKey, artifactName, now] = this.values;
						submissions.push({ id: nextSubmissionId++, user_id: userId, name, title, description, source_type: sourceType, source_url: sourceUrl, artifact_key: artifactKey, artifact_name: artifactName, status: "pending", created_at: now, updated_at: now, author_login: usersById.get(userId)?.login ?? "unknown" });
						return { success: true };
					}
					if (sql.startsWith("UPDATE task_submissions SET status")) {
						const [status, reviewerId, note, now, id] = this.values;
						const item = submissions.find((submission) => submission.id === id);
						item.status = status;
						item.reviewer_user_id = reviewerId;
						item.review_note = note;
						item.updated_at = now;
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_versions")) {
						const [taskName, version, submissionId, artifactKey, sourceUrl, publishedByUserId, now] = this.values;
						versions.push({ task_name: taskName, version, submission_id: submissionId, artifact_key: artifactKey, source_url: sourceUrl, published_by_user_id: publishedByUserId, created_at: now });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO tasks")) {
						const [name, title, description, authorUserId, authorName, now] = this.values;
						tasks.set(name, { title, description, author_user_id: authorUserId, author_name: authorName, created_at: now, download_count: 0, like_count: 0, favorite_count: 0 });
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
					if (sql.startsWith("INSERT INTO download_events")) {
						const [taskName, userId, now] = this.values;
						downloads.push({ id: downloads.length + 1, task_name: taskName, user_id: userId, created_at: now });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_reports")) {
						const [taskName, userId, reason, now] = this.values;
						if (!reports.some((item) => item.task_name === taskName && item.user_id === userId)) reports.push({ id: reports.length + 1, task_name: taskName, user_id: userId, reason, status: "open", created_at: now });
						return { success: true };
					}
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

function createR2() {
	const objects = new Map();
	return {
		objects,
		async put(key, value) {
			objects.set(key, value);
		},
		async get(key) {
			return objects.has(key) ? { body: objects.get(key), httpMetadata: { contentType: "application/zip" } } : null;
		},
	};
}

function env() {
	return {
		DB: createDb(),
		TASK_UPLOADS: createR2(),
		ADMIN_GITHUB_LOGINS: "octo",
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

test("signed-in users submit taskbooks and see pending submissions", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "my-task");
	form.set("title", "My Task");
	form.set("description", "Does one useful thing");
	form.set("sourceUrl", "https://github.com/example/my-task");
	form.set("artifact", new File(["zip"], "my-task.zip", { type: "application/zip" }));

	const submitResponse = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const submitted = await submitResponse.json();
	const accountResponse = await accountSubmissions(new Request("https://ugk-task-share.pages.dev/api/account/submissions", { headers: { cookie } }), testEnv);
	const account = await accountResponse.json();

	assert.equal(submitted.status, "pending");
	assert.equal(submitted.name, "my-task");
	assert.equal(account.submissions.length, 1);
	assert.equal(testEnv.TASK_UPLOADS.objects.size, 1);
});

test("admins publish pending submissions into the public queue", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "public-task");
	form.set("title", "Public Task");
	form.set("description", "Ready for review");
	form.set("sourceUrl", "https://github.com/example/public-task");
	await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);

	const pending = await (await adminSubmissions(new Request("https://ugk-task-share.pages.dev/api/admin/submissions", { headers: { cookie } }), testEnv)).json();
	const review = await reviewSubmission(
		new Request("https://ugk-task-share.pages.dev/api/admin/submissions/1", { method: "POST", headers: { cookie }, body: JSON.stringify({ status: "published", note: "ok" }) }),
		testEnv,
		1,
	);
	const publicTasks = await (await communityTasks(testEnv)).json();

	assert.equal(pending.submissions.length, 1);
	assert.equal((await review.json()).status, "published");
	assert.equal(publicTasks.tasks[0].name, "public-task");
});

test("signed-in users see per-task download state and account downloads", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	const stats = await (await getTaskStats(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/stats", { headers: { cookie } }), testEnv, "video-downloader")).json();
	const account = await (await accountDownloads(new Request("https://ugk-task-share.pages.dev/api/account/downloads", { headers: { cookie } }), testEnv)).json();

	assert.equal(stats.downloaded, true);
	assert.equal(account.downloads[0].name, "video-downloader");
});

test("signed-in users can report a task once and admins can review reports", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	const report = await reportTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/report", { method: "POST", headers: { cookie }, body: JSON.stringify({ reason: "Broken artifact" }) }),
		testEnv,
		"video-downloader",
	);
	const duplicate = await reportTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/report", { method: "POST", headers: { cookie }, body: JSON.stringify({ reason: "Broken artifact again" }) }),
		testEnv,
		"video-downloader",
	);
	const reports = await (await adminReports(new Request("https://ugk-task-share.pages.dev/api/admin/reports", { headers: { cookie } }), testEnv)).json();

	assert.equal((await report.json()).reported, true);
	assert.equal((await duplicate.json()).reported, true);
	assert.equal(reports.reports.length, 1);
});

test("published submissions expose immutable task versions", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "versioned-task");
	form.set("title", "Versioned Task");
	form.set("description", "Ready for versions");
	form.set("sourceUrl", "https://github.com/example/versioned-task");

	await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	await reviewSubmission(
		new Request("https://ugk-task-share.pages.dev/api/admin/submissions/1", { method: "POST", headers: { cookie }, body: JSON.stringify({ status: "published" }) }),
		testEnv,
		1,
	);
	const versions = await (await getTaskVersions(testEnv, "versioned-task")).json();

	assert.equal(versions.versions[0].version, "1.0.0");
});

test("stats detail rolls download events up by day", async () => {
	const testEnv = env();
	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const detail = await (await getTaskStatsDetail(testEnv, "video-downloader")).json();

	assert.equal(detail.days[0].downloads, 1);
	assert.match(detail.days[0].day, /^\d{4}-\d{2}-\d{2}$/);
});
