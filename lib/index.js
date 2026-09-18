import { A as WorkBuddyUpstreamClient, C as defaultDesktopAuthDirs, D as parseWorkBuddyAuth, E as isFresher, F as prepareChatBody, I as regionOf, L as selectCliModels, M as parseCreditMultiplier, N as parseReasoning, O as workbuddyAccountId, P as parseUpstreamModel, S as defaultDesktopAuthCandidates, T as expiryToMs, _ as deriveCatalog, a as readHostHeartbeat, b as WorkBuddyCredentialStore, c as WORKBUDDY2API_VERSION, d as nextDay4Am, f as stickyKeyOf, g as applyContextBudgets, h as WorkBuddyCatalog, i as processStartTimeMs, j as classifyUpstreamError, k as workbuddyOwnAuthPath, l as DEFAULT_WORKBUDDY_POOL_POLICY, m as FALLBACK_WORKBUDDY_MODELS_GLOBAL, n as clearHostHeartbeat, o as workbuddyHostHeartbeatPath, p as FALLBACK_WORKBUDDY_MODELS, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDY2API_HOST_HEARTBEAT_FILENAME, u as WorkBuddyAccountPool, v as fallbackModelsFor, w as defaultDesktopAuthPath, x as authFileName, y as WORKBUDDY_AUTH_FILE_ENV } from "./host-heartbeat-BwvAd8aB.js";
import z from "@deepseek-ai/schemastery";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/adapter.ts
/**
* The WorkBuddy pi-ai provider: a loopback-backed adapter registered into the
* Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
*     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）、模型描述符
*     的构造、`getModels` 委托给实时读取的做法，均来自该项目；
*   DSH 插件结构与 provider 注册的思路参照
*     franksong2702/dsh-codex-connect（Apache-2.0），经其转引。
* 改动：provider 按区域实例化 —— `workbuddy2api`（国内版账号池）与
*   `workbuddy2api-global`（国际版账号池）。两边各有自己的账号池、
*   模型目录与 shim，因此同一个上游 model id（`deepseek-v4.1-flash`）
*   在两个区域可以各自保留自己的积分倍率而不互相覆盖。
*
* @module dsh-workbuddy2api/adapter
*/
/** Provider route the domestic account pool registers as. */
const WORKBUDDY2API_PROVIDER = "workbuddy2api";
/** Provider route the international account pool registers as. */
const WORKBUDDY2API_GLOBAL_PROVIDER = "workbuddy2api-global";
/** The provider id each region registers as. */
const WORKBUDDY2API_PROVIDERS = {
	cn: WORKBUDDY2API_PROVIDER,
	global: WORKBUDDY2API_GLOBAL_PROVIDER
};
/** Region a provider route id belongs to. */
function regionOfProvider(provider) {
	for (const [region, id] of Object.entries(WORKBUDDY2API_PROVIDERS)) if (id === provider) return region;
}
/** Human-readable provider names, shown in the DSH model picker. */
const WORKBUDDY2API_PROVIDER_DISPLAY_NAMES = {
	cn: "WorkBuddy 账号池",
	global: "WorkBuddy 账号池（国际版）"
};
/** Default display name, kept for callers that do not name a region. */
const WORKBUDDY2API_PROVIDER_DISPLAY_NAME = WORKBUDDY2API_PROVIDER_DISPLAY_NAMES.cn;
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy2api route authenticates only through
* the shim shared secret resolved per request by `resolveApiKey`, so pi-ai's
* own credential lifecycle and ambient discovery must never manufacture a
* credential for it.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy2api: the workbuddy2api route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** pi-ai input modalities: images only when the user opted the model in. */
function workBuddyModelInput(info) {
	return info.multimodal === true ? ["text", "image"] : ["text"];
}
/**
* DSH-facing display name: the model name plus the upstream credit multiplier,
* spelled the way WorkBuddy's own selector does (`GLM-5.3 · x0.79`).
*
* Display-only by construction: every DSH-side join keys on the model id.
*/
function workBuddyDisplayName(info) {
	return info.creditMultiplier === void 0 ? info.name : `${info.name} · x${info.creditMultiplier.toFixed(2)}`;
}
/** Map only levels advertised by WorkBuddy; undeclared DSH levels stay unavailable. */
function workBuddyThinkingLevelMap(info) {
	const supported = info.reasoning?.supportedEfforts?.filter((effort) => THINKING_LEVELS.includes(effort));
	if (supported === void 0 || supported.length === 0) return void 0;
	const map = Object.fromEntries(THINKING_LEVELS.map((level) => [level, supported.includes(level) ? level : null]));
	if (info.reasoning?.canDisableThinking !== true) map.off = null;
	return map;
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const thinkingLevelMap = workBuddyThinkingLevelMap(info);
	return {
		id: info.id,
		name: workBuddyDisplayName(info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: workBuddyModelInput(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		reasoning: thinkingLevelMap !== void 0,
		...thinkingLevelMap === void 0 ? {} : { thinkingLevelMap },
		compat: { supportsReasoningEffort: thinkingLevelMap !== void 0 }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog, and
* every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
* applies from the first snapshot after startup.
*/
function createWorkBuddyAdapter(options) {
	const { shim, catalog, resolveAttachments, region } = options;
	const providerId = options.provider ?? WORKBUDDY2API_PROVIDERS[region];
	const providerName = options.displayName ?? WORKBUDDY2API_PROVIDER_DISPLAY_NAMES[region];
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "WorkBuddy account-pool loopback token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy2api retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the WorkBuddy wire quirks (forced streaming, string
* `tool_choice`, CLI-shaped headers) and forwards to the real upstream. It
* binds 127.0.0.1 only and never serves another interface.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 入站加固的四重校验（Host 必须回环、Origin 必须回环、chat POST 必须
*     JSON、bearer 必须匹配进程内随机 secret）、常量时间比对、随机端口绑定、
*     body 上限、上游错误分类到 HTTP 状态码的映射，均由该项目设计并验证
*     （其源自 corrinehu/dsh-workbuddy-connect (MIT)）。
* 改动：chat 请求的凭据不再来自「当前选中的唯一账号」，而是每一步都向
*   账号池要一个账号（会话粘性 → 加权选号），请求结束后把结果回报给池
*   做健康迁移；失败时按「可重试分类 + 剩余尝试次数」换号重试，
*   这正是多账号相对单账号的核心增量。安全相关代码不做「改善」，原样沿用。
*
* @module dsh-workbuddy2api/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Loopback hostnames the shim's own in-process client uses. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Failure classes worth retrying on a different account. */
const RETRYABLE = /* @__PURE__ */ new Set([
	"hard_credit",
	"soft_rate",
	"session_dead",
	"server"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser clients
* (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
/** HTTP status each "the pool could not find an account" answer surfaces as. */
const MISS_STATUS = {
	"no-accounts": 401,
	"all-disabled": 503,
	"pool-saturated": 503
};
const MISS_MESSAGE = {
	"no-accounts": "no WorkBuddy account is signed in; sign in once in the WorkBuddy desktop app, then refresh the pool",
	"all-disabled": "every account in the WorkBuddy pool is switched off; enable one in the plugin card",
	"pool-saturated": "every WorkBuddy account is busy or cooling down; retry shortly"
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests must carry the shim's shared secret;
* the loopback bind alone is not a trust boundary.
*/
function createWorkBuddyShim(options) {
	const { store, pool, client, catalog } = options;
	const logger = options.logger;
	const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const a = Buffer.from(match[1]);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, {
					ok: true,
					accounts: pool.snapshot().length
				});
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const prepared = prepareChatBody(raw);
		const stickyKey = stickyKeyOf(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const attempted = /* @__PURE__ */ new Set();
		let lastFailure;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const picked = pool.pick({
				exclude: attempted,
				...stickyKey === void 0 ? {} : { stickyKey }
			});
			if (!picked.ok) {
				if (lastFailure !== void 0) {
					writeOpenAIError(res, lastFailure.status, lastFailure.kind, `workbuddy upstream ${lastFailure.kind} (http ${lastFailure.status}): ${lastFailure.message.slice(0, 400)}`);
					return;
				}
				writeOpenAIError(res, MISS_STATUS[picked.reason], picked.reason, MISS_MESSAGE[picked.reason]);
				return;
			}
			const accountId = picked.entry.accountId;
			if (picked.fallback) logger?.warn(`dsh-workbuddy2api: every account is cooling down; trying ${accountId}, whose cooldown expires first`);
			attempted.add(accountId);
			let credential;
			try {
				credential = await store.resolve(accountId);
			} catch (error) {
				pool.report(accountId, {
					ok: false,
					kind: "session_dead",
					message: String(error)
				});
				lastFailure = {
					status: 401,
					kind: "session_dead",
					message: String(error)
				};
				pool.release(accountId);
				continue;
			}
			let result;
			try {
				result = await client.chatStream(credential, prepared, controller.signal);
			} finally {
				pool.release(accountId);
			}
			if (result.ok) {
				pool.report(accountId, { ok: true }, stickyKey);
				if (controller.signal.aborted) {
					result.response.body?.cancel().catch(() => {});
					return;
				}
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"X-Accel-Buffering": "no"
				});
				let sawDone = false;
				const body = Readable.fromWeb(result.response.body);
				body.on("data", (chunk) => {
					if (chunk.includes("[DONE]")) sawDone = true;
				});
				body.on("error", (error) => {
					logger?.warn("dsh-workbuddy2api: upstream stream failed mid-flight", error);
					if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
				});
				body.pipe(res);
				return;
			}
			pool.report(accountId, {
				ok: false,
				...result.status === 0 ? {} : { kind: result.kind },
				message: result.message
			});
			lastFailure = {
				status: KIND_STATUS[result.kind],
				kind: result.kind,
				message: result.message
			};
			if (!RETRYABLE.has(result.kind) || controller.signal.aborted) break;
			logger?.warn(`dsh-workbuddy2api: account ${accountId} failed with ${result.kind}; retrying on another account`);
		}
		if (lastFailure !== void 0) {
			writeOpenAIError(res, lastFailure.status, lastFailure.kind, `workbuddy upstream ${lastFailure.kind} (http ${lastFailure.status}): ${lastFailure.message.slice(0, 400)}`);
			return;
		}
		writeOpenAIError(res, 503, "pool-exhausted", "every WorkBuddy account failed for this request");
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the Host and browser halves.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 「同源只读路由 + 一份与浏览器共享的 node-free 类型定义」的 host↔client
*     桥梁形态来自该项目（其源自 dsh-connect-trae，并注明沿用
*     corrinehu/dsh-workbuddy-connect 的 status-route 模式）。
* 改动：
*   1. 文档结构从「一个账号 + 一份目录」改成「账号池 + 每账号健康 + 一份目录」；
*   2. 区域（cn | global）从可选字段升级为路由、配置与 provider 的主键 ——
*      国内版与国际版是两个独立账号池、两个独立 provider、两份独立目录。
*
* @module dsh-workbuddy2api/status-paths
*/
/** Plugin-owned usage endpoint consumed by its browser half. */
const WORKBUDDY2API_USAGE_PATH = "/plugins/dsh-workbuddy2api/usage";
/** Plugin-owned live model refresh endpoint. */
const WORKBUDDY2API_MODELS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/models/refresh";
/** Plugin-owned local account rescan endpoint. */
const WORKBUDDY2API_ACCOUNTS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/accounts/refresh";
/** Plugin-owned per-account credit refresh endpoint. */
const WORKBUDDY2API_CREDITS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/credits/refresh";
/** Plugin-owned daily check-in action endpoint. */
const WORKBUDDY2API_CHECKIN_PATH = "/plugins/dsh-workbuddy2api/checkin";
/** Plugin-owned pool control endpoint (reset / release). */
const WORKBUDDY2API_POOL_ACTION_PATH = "/plugins/dsh-workbuddy2api/pool";
/** Query parameter naming the account a card request addresses. */
const WORKBUDDY2API_ACCOUNT_PARAM = "accountId";
/** Query parameter naming the REGION (i.e. which pool) a card request addresses. */
const WORKBUDDY2API_REGION_PARAM = "region";
/**
* Both regions, in tab order.
*
* The two regions are NOT a display grouping: each owns a separate account
* pool, a separate provider route, and a separate model directory. They must
* stay separate because the upstream reuses one model id for different things
* per region — `deepseek-v4.1-flash` is a free promotional model on the
* international gateway and a paid one on the domestic gateway — so merging
* the two directories silently replaces one region's rate with the other's.
*/
const WORKBUDDY2API_REGIONS = ["cn", "global"];
/**
* Address one region's status route. Every card request carries the region
* whose tab the user is on, so a tab can only ever read and write its own
* pool, credits, and model slot.
*/
function withWorkBuddyRegion(path, region) {
	return `${path}?${WORKBUDDY2API_REGION_PARAM}=${region}`;
}
/**
* Read the region parameter off a status-route URL. Absent means the domestic
* tab (`cn`); a present-but-unknown value returns undefined so the route can
* answer 400 instead of silently addressing the wrong pool.
*/
function regionOfStatusUrl(url) {
	const at = url.indexOf("?");
	const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY2API_REGION_PARAM);
	if (value === null || value === "") return "cn";
	return WORKBUDDY2API_REGIONS.includes(value) ? value : void 0;
}
/**
* Project one card row into its persisted `lastCatalog` shape: the native
* context window becomes the stored `contextWindow`, and the card-only
* presentation fields (`nativeContextWindow`, `multimodal`) are removed BY
* KEY. They must never be set to `undefined`: explicit `undefined` values
* survive `structuredClone` and are rejected by the settings write path's
* strict JSON codec, which fails the whole save.
*/
function toPersistedWorkBuddyModel(model) {
	const { nativeContextWindow, multimodal: _cardOnly, ...rest } = model;
	return {
		...rest,
		contextWindow: nativeContextWindow
	};
}
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** Map the credit answer to the card's compact document. */
function toCredits(answer) {
	return {
		total: answer.total,
		packages: answer.packages.map((pack) => ({
			packageName: pack.packageName,
			remain: pack.remain,
			size: pack.size,
			monthly: pack.monthly,
			...pack.refreshAtMs === void 0 ? {} : { cycleRefreshMs: pack.refreshAtMs },
			...pack.expiresAtMs === void 0 ? {} : { expiresAtMs: pack.expiresAtMs }
		})),
		expiringSoon: answer.expiringSoon,
		...answer.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: answer.nearestExpiryMs }
	};
}
/** Project a model into the card's row, dropping empty optional fields. */
function toWebModel(model, budgets) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow > 2e5 ? Math.min(model.contextWindow, budgets[model.id] ?? 2e5) : model.contextWindow,
		nativeContextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
		...model.multimodal === void 0 ? {} : { multimodal: model.multimodal },
		...model.reasoning === void 0 ? {} : { reasoning: {
			...model.reasoning.supportedEfforts === void 0 ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] },
			...model.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort }
		} }
	};
}
/** The account id a request addresses, or undefined when it names none. */
function requestAccountId(req) {
	const url = req.url ?? "/";
	const at = url.indexOf("?");
	if (at === -1) return void 0;
	const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY2API_ACCOUNT_PARAM);
	return value === null || value === "" ? void 0 : value;
}
/** Read a small JSON body; unparsable or absent bodies answer `{}`. */
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/** One region's account list, token-free, annotated with its pool's switch. */
async function accountsOf(deps, region) {
	const pool = deps.pool(region);
	return (await deps.store(region).accounts()).map((account) => ({
		id: account.id,
		accountName: account.accountName,
		...account.uin === void 0 ? {} : { uin: account.uin },
		domain: account.domain,
		region: account.region,
		source: account.source,
		tokenExpiresAtMs: account.tokenExpiresAtMs,
		enabled: pool.entryView(account.id)?.enabled ?? true,
		present: true
	}));
}
/**
* Assemble one region's card document: that region's locally discovered
* accounts, its pool's live health per account, its cached credits, and its
* model directory with the user's selection within it. Credit queries never run
* here — the pool's cache is read instead, so a 60-second card poll does not
* hammer N upstream billing endpoints.
*/
async function workBuddyWebStatus(deps, region) {
	const pool = deps.pool(region);
	try {
		await pool.refresh();
	} catch (error) {
		return {
			status: "error",
			region,
			message: safeMessage(error)
		};
	}
	let accounts;
	try {
		accounts = await accountsOf(deps, region);
	} catch (error) {
		return {
			status: "error",
			region,
			message: safeMessage(error)
		};
	}
	const entries = pool.snapshot();
	if (accounts.length === 0) return {
		status: "empty",
		region,
		accounts: [],
		pool: entries,
		message: region === "global" ? "no international WorkBuddy sign-in found; sign in once in the WorkBuddy AI app, then refresh this tab" : "no domestic WorkBuddy sign-in found; sign in once in the WorkBuddy desktop app, then refresh this tab"
	};
	const credits = entries.map((entry) => ({
		accountId: entry.accountId,
		...entry.credits === void 0 ? {} : { credits: {
			total: entry.credits,
			packages: [],
			expiringSoon: entry.creditsExpiringSoon ?? 0
		} }
	}));
	return {
		status: "ready",
		region,
		accounts,
		pool: entries,
		credits,
		models: deps.displayModels(region).map((model) => toWebModel(model, deps.contextBudgets(region))),
		enabledModelIds: [...deps.enabledModelIds(region)],
		imageModelIds: [...deps.imageModelIds(region)],
		poolState: [...deps.poolState(region)],
		policy: deps.policy(region)
	};
}
/**
* Mount the routes on a context where `webServer` is available. The caller uses
* `ctx.inject(['webServer'], ...)`, so Desktop startup order cannot make this
* registration disappear.
*/
function registerWorkBuddy2ApiStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const guard = (req, res, method) => {
			if (req.method !== method) {
				json(res, 405, { error: "method not allowed" });
				return false;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return false;
			}
			return true;
		};
		/**
		* The region a request addresses, or a 400 answer. Absent means the
		* domestic tab; an unknown value is refused rather than guessed, so a
		* malformed request can never silently address the wrong pool.
		*/
		const requestRegion = (req, res) => {
			const region = regionOfStatusUrl(req.url ?? "/");
			if (region === void 0) {
				json(res, 400, { error: "unknown region" });
				return;
			}
			return region;
		};
		const disposeUsage = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_USAGE_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					json(res, 200, await workBuddyWebStatus(deps, region));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeAccounts = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					await deps.pool(region).refresh();
					json(res, 200, {
						region,
						accounts: await accountsOf(deps, region),
						pool: deps.pool(region).snapshot()
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeCredits = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_CREDITS_REFRESH_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				if (deps.refreshCredits === void 0) {
					json(res, 503, { error: "credit refresh unavailable" });
					return;
				}
				try {
					await deps.pool(region).refresh();
					const named = requestAccountId(req);
					const wanted = named === void 0 ? deps.pool(region).snapshot().map((entry) => entry.accountId) : [named];
					const refreshCredits = deps.refreshCredits;
					json(res, 200, {
						region,
						credits: (await Promise.allSettled(wanted.map(async (accountId) => ({
							accountId,
							credits: await refreshCredits(region, accountId)
						})))).map((result, index) => result.status === "fulfilled" ? {
							accountId: wanted[index],
							credits: toCredits(result.value.credits)
						} : {
							accountId: wanted[index],
							creditsError: safeMessage(result.reason)
						}),
						pool: deps.pool(region).snapshot()
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeCheckin = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_CHECKIN_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				const accountId = requestAccountId(req);
				if (accountId === void 0) {
					json(res, 400, { error: "accountId is required" });
					return;
				}
				try {
					const credential = await deps.store(region).resolve(accountId);
					const current = await deps.client.fetchCheckinStatus(credential);
					if (!current.active) {
						json(res, 409, { error: "check-in activity is not active" });
						return;
					}
					if (current.todayCheckedIn) {
						json(res, 200, {
							region,
							alreadyCheckedIn: true,
							checkin: current
						});
						return;
					}
					json(res, 200, {
						region,
						alreadyCheckedIn: false,
						claim: await deps.client.claimDailyCheckin(credential),
						checkin: await deps.client.fetchCheckinStatus(credential)
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeModels = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_MODELS_REFRESH_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				if (deps.discoverModels === void 0) {
					json(res, 503, { error: "model refresh unavailable" });
					return;
				}
				try {
					json(res, 200, {
						region,
						models: (await deps.discoverModels(region)).map((model) => toWebModel(model, deps.contextBudgets(region)))
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposePool = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY2API_POOL_ACTION_PATH,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					const body = await readJsonBody(req);
					const action = typeof body["action"] === "string" ? body["action"] : "";
					const accountId = typeof body["accountId"] === "string" ? body["accountId"] : void 0;
					if (accountId === void 0) {
						json(res, 400, { error: "accountId is required" });
						return;
					}
					if (action === "reset") deps.pool(region).reset(accountId);
					else if (action === "release") deps.pool(region).release(accountId);
					else {
						json(res, 400, { error: `unknown pool action: ${action}` });
						return;
					}
					json(res, 200, {
						region,
						pool: deps.pool(region).snapshot(),
						poolState: [...deps.poolState(region)]
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		return () => {
			disposePool();
			disposeModels();
			disposeCheckin();
			disposeCredits();
			disposeAccounts();
			disposeUsage();
		};
	}, "dsh-workbuddy2api: Web status route");
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "dsh-workbuddy2api";
/** The model registry and settings service required before providers can register. */
const inject = ["llm", "settings"];
/** Settings namespace for the plugin configuration card. */
const WORKBUDDY2API_SETTINGS_NS = "workbuddy2api";
const modelConfig = z.object({
	id: z.string().required(),
	name: z.string().required(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	creditMultiplier: z.number(),
	reasoning: z.object({
		supportedEfforts: z.array(z.string()).default([]),
		defaultEffort: z.string(),
		canDisableThinking: z.boolean()
	}),
	descriptionZh: z.string(),
	descriptionEn: z.string(),
	supportsToolCall: z.boolean()
});
const poolStateConfig = z.object({
	accountId: z.string().required(),
	enabled: z.boolean().default(true),
	weight: z.number().step(1).min(1).max(100).default(10),
	priority: z.number().step(1).default(100),
	cooldownUntil: z.number(),
	cooldownKind: z.union([z.const("soft"), z.const("hard")]),
	cooldownCount: z.number().step(1).min(0),
	breakerUntil: z.number(),
	degradedUntil: z.number()
});
const poolPolicyConfig = z.object({
	maxInFlightPerAccount: z.number().step(1).min(0),
	maxInFlightGlobalPerAccount: z.number().step(1).min(0),
	maxInFlightTotal: z.number().step(1).min(0),
	softRateCooldownMs: z.number().step(1).min(0),
	softRateCooldownMaxMs: z.number().step(1).min(0),
	notFoundCooldownMs: z.number().step(1).min(0),
	breakerThreshold: z.number().step(1).min(1),
	breakerCooldownMs: z.number().step(1).min(0),
	breakerCooldownMaxMs: z.number().step(1).min(0),
	degradeThreshold: z.number().step(1).min(1),
	degradeCooldownMs: z.number().step(1).min(0),
	degradeCooldownMaxMs: z.number().step(1).min(0),
	stickyTtlMs: z.number().step(1).min(0),
	stickyGcIntervalMs: z.number().step(1).min(0),
	balanceAware: z.boolean(),
	idleWeightPerHour: z.number().min(0),
	idleWeightMax: z.number().min(0),
	expiringWeight: z.number().min(0),
	expiringSoonMs: z.number().step(1).min(0),
	minPickGapMs: z.number().step(1).min(0)
});
const regionStateConfig = z.object({
	lastCatalog: z.array(modelConfig).default([]),
	enabledModelIds: z.array(z.string()).default([]),
	imageModelIds: z.array(z.string()).default([]),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
	poolState: z.array(poolStateConfig).default([]),
	pool: poolPolicyConfig.description("Account-pool health policy overrides for this region")
});
/**
* The plugin configuration schema.
*
* The shape is asserted once at the export boundary rather than per field: a
* cast inside an object literal cannot carry a nested generic such as
* `z<Partial<Record<Region, State>>>` — the parser loses the expression context
* at the closing brackets — so the single outer assertion is both the portable
* form and the one place a reader has to check.
*/
const Config = z.object({
	authFile: z.string().description(`WorkBuddy desktop auth file (defaults to the app's own location)`),
	regions: z.dict(regionStateConfig).default({}).description("Per-region model directory, selection, and pool state, keyed cn | global"),
	lastCatalog: z.array(modelConfig).default([]).description("Deprecated 0.1.x: merged model directory (ignored)"),
	enabledModelIds: z.array(z.string()).default([]).description("Deprecated 0.1.x: merged selection (ignored)"),
	imageModelIds: z.array(z.string()).default([]).description("Deprecated 0.1.x: merged image opt-in (ignored)"),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("Deprecated 0.1.x: merged budgets (ignored)"),
	poolState: z.array(poolStateConfig).default([]).description("Deprecated 0.1.x: single-pool state (ignored)"),
	pool: poolPolicyConfig.description("Deprecated 0.1.x: single-pool policy (ignored)")
});
/** Every region, in card tab order. */
const REGION_KEYS = ["cn", "global"];
/** One region's saved state, or an empty state when it was never configured. */
function regionStateOf(config, region) {
	return config.regions?.[region] ?? {};
}
/** The persisted model directory in the shape the runtime catalog needs. */
function toModelInfo(model) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
		...model.reasoning === void 0 ? {} : { reasoning: {
			...model.reasoning.supportedEfforts === void 0 || model.reasoning.supportedEfforts.length === 0 ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] },
			...model.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort },
			...model.reasoning.canDisableThinking === void 0 ? {} : { canDisableThinking: model.reasoning.canDisableThinking }
		} },
		...model.descriptionZh === void 0 ? {} : { descriptionZh: model.descriptionZh },
		...model.descriptionEn === void 0 ? {} : { descriptionEn: model.descriptionEn },
		...model.supportsToolCall === void 0 ? {} : { supportsToolCall: model.supportsToolCall }
	};
}
/** One region's persisted policy over the defaults, dropping unknown values. */
function resolvePolicy(configured) {
	const policy = { ...DEFAULT_WORKBUDDY_POOL_POLICY };
	if (configured !== void 0) for (const [key, value] of Object.entries(configured)) {
		if (value === void 0 || value === null) continue;
		if (typeof policy[key] === "boolean") {
			if (typeof value === "boolean") policy[key] = value;
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) policy[key] = value;
	}
	if (policy.softRateCooldownMaxMs > 0 && policy.softRateCooldownMs > policy.softRateCooldownMaxMs) policy.softRateCooldownMs = policy.softRateCooldownMaxMs;
	if (policy.breakerCooldownMaxMs > 0 && policy.breakerCooldownMs > policy.breakerCooldownMaxMs) policy.breakerCooldownMs = policy.breakerCooldownMaxMs;
	if (policy.degradeCooldownMaxMs > 0 && policy.degradeCooldownMs > policy.degradeCooldownMaxMs) policy.degradeCooldownMs = policy.degradeCooldownMaxMs;
	return policy;
}
/**
* Start both regions' loopback endpoints, register the `workbuddy2api` (CN) and
* `workbuddy2api-global` (international) providers, and refresh each region's
* model catalog from its own accounts. Each region's static fallback catalog
* serves from the first moment, so an offline upstream never leaves a provider
* empty.
*/
function apply(ctx, config) {
	const client = new WorkBuddyUpstreamClient();
	const stacks = {};
	for (const region of REGION_KEYS) {
		const store = new WorkBuddyCredentialStore({
			region,
			...config.authFile === void 0 ? {} : { desktopPath: config.authFile },
			refresh: (credential) => client.refreshToken(credential)
		});
		const catalog = new WorkBuddyCatalog(region);
		const pool = new WorkBuddyAccountPool({
			list: () => store.accounts(),
			...regionStateOf(config, region).poolState === void 0 ? {} : { state: regionStateOf(config, region).poolState },
			policy: resolvePolicy(regionStateOf(config, region).pool)
		});
		stacks[region] = {
			store,
			pool,
			catalog,
			shim: createWorkBuddyShim({
				store,
				pool,
				client,
				catalog,
				logger: ctx.logger
			})
		};
	}
	const withImageSelection = (models, images) => models.map((model) => ({
		...model,
		...images.has(model.id) ? { multimodal: true } : { multimodal: false }
	}));
	/**
	* The runtime catalog for one region: that region's last-refreshed directory,
	* filtered by that region's selection. A region that was never refreshed falls
	* back to ITS OWN static roster — never the other region's.
	*/
	const configuredModels = (value, region) => {
		const state = regionStateOf(value, region);
		return withImageSelection(deriveCatalog(state.lastCatalog?.length ? state.lastCatalog.map(toModelInfo) : fallbackModelsFor(region), new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}), new Set(state.imageModelIds ?? []));
	};
	/** What one region's card displays: its last-refreshed directory, unfiltered. */
	const displayModels = (value, region) => {
		const state = regionStateOf(value, region);
		return state.lastCatalog?.length ? state.lastCatalog.map(toModelInfo) : fallbackModelsFor(region);
	};
	let current = () => config;
	let invalidateCatalog = () => {};
	/** Read one region's live directory from that region's own accounts. */
	const discoverModels = async (region, signal) => {
		const stack = stacks[region];
		await stack.pool.refresh();
		const ids = stack.pool.snapshot().filter((entry) => entry.present).map((entry) => entry.accountId);
		const credentials = await stack.store.byIds(ids);
		return client.fetchModelsForCredentials(credentials, signal);
	};
	/** Push the current config into every region's pool selection and catalog. */
	const applySelection = (value) => {
		for (const region of REGION_KEYS) {
			const stack = stacks[region];
			const state = regionStateOf(value, region);
			stack.store.setDesktopPath(value.authFile);
			stack.pool.configure((state.poolState ?? []).map((record) => ({
				accountId: record.accountId,
				enabled: record.enabled,
				weight: record.weight,
				priority: record.priority
			})));
			stack.pool.setPolicy(resolvePolicy(state.pool));
			try {
				stack.catalog.set(configuredModels(value, region));
			} catch (error) {
				ctx.logger.warn(`dsh-workbuddy2api: ${region} runtime catalog rejected; keeping the previous directory`, error);
			}
		}
		invalidateCatalog();
	};
	ctx.inject(["webServer"], (webCtx) => registerWorkBuddy2ApiStatusRoute(webCtx, {
		store: (region) => stacks[region].store,
		pool: (region) => stacks[region].pool,
		client,
		displayModels: (region) => displayModels(current(), region),
		enabledModelIds: (region) => regionStateOf(current(), region).enabledModelIds ?? [],
		imageModelIds: (region) => regionStateOf(current(), region).imageModelIds ?? [],
		contextBudgets: (region) => regionStateOf(current(), region).contextBudgets ?? {},
		poolState: (region) => stacks[region].pool.toPersisted(),
		policy: (region) => stacks[region].pool.currentPolicy(),
		discoverModels,
		refreshCredits: async (region, accountId) => {
			const credential = await stacks[region].store.resolve(accountId);
			const credits = await client.fetchCredits(credential);
			stacks[region].pool.setCredits(accountId, {
				total: credits.total,
				expiringSoon: credits.expiringSoon
			});
			return credits;
		}
	}));
	ctx.settings.installSection(ctx, WORKBUDDY2API_SETTINGS_NS, Config, config, {
		setSource(source) {
			current = source;
		},
		onChange() {
			applySelection(current());
		}
	});
	applySelection(config);
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		for (const region of REGION_KEYS) {
			stacks[region].pool.dispose();
			stacks[region].shim.close();
		}
		clearHostHeartbeat();
	});
	Promise.all(REGION_KEYS.map((region) => stacks[region].shim.ready)).then(async () => {
		if (stopped) return;
		const adapters = {};
		const releases = [];
		try {
			for (const region of REGION_KEYS) adapters[region] = createWorkBuddyAdapter({
				shim: stacks[region].shim,
				catalog: stacks[region].catalog,
				region,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidateCatalog = () => {
				for (const region of REGION_KEYS) adapters[region].invalidate();
			};
			try {
				for (const region of REGION_KEYS) releases.push(ctx.llm.registerAdapter([WORKBUDDY2API_PROVIDERS[region]], adapters[region].adapter));
				releases.push(ctx.llm.registerConfigurableProviders(REGION_KEYS.map((region) => ({
					provider: WORKBUDDY2API_PROVIDERS[region],
					displayName: WORKBUDDY2API_PROVIDER_DISPLAY_NAMES[region],
					settingsNs: WORKBUDDY2API_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}))));
			} catch (error) {
				for (const release of releases.splice(0)) release();
				throw error;
			}
			const landed = [...releases];
			try {
				ctx.effect(() => () => {
					for (const release of landed) release();
				});
			} catch {
				for (const release of landed) release();
			}
			ctx.llm.registerModelDiscovery(WORKBUDDY2API_SETTINGS_NS, async (request, signal) => {
				const region = regionOfProvider(request.provider ?? "workbuddy2api");
				if (region === void 0) return [];
				const discovered = await discoverModels(region, signal);
				const state = regionStateOf(current(), region);
				return withImageSelection(deriveCatalog(discovered, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}), new Set(state.imageModelIds ?? [])).map((model) => ({
					id: model.id,
					name: workBuddyDisplayName(model),
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					inputModalities: workBuddyModelInput(model)
				}));
			});
		} catch (error) {
			for (const release of releases) release();
			ctx.logger.error("dsh-workbuddy2api: provider registration failed", error);
			return;
		}
		(async () => {
			let accounts = 0;
			for (const region of REGION_KEYS) try {
				await stacks[region].pool.refresh();
				accounts += stacks[region].pool.snapshot().length;
			} catch (error) {
				ctx.logger.warn(`dsh-workbuddy2api: ${region} account scan failed at startup`, error);
			}
			writeHostHeartbeat(accounts);
		})();
		for (const region of REGION_KEYS) (async () => {
			try {
				const models = await discoverModels(region);
				if (stopped) return;
				const state = regionStateOf(current(), region);
				stacks[region].catalog.set(withImageSelection(deriveCatalog(models, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}), new Set(state.imageModelIds ?? [])));
				adapters[region].invalidate();
			} catch (error) {
				ctx.logger.warn(`dsh-workbuddy2api: dynamic ${region} model catalog unavailable; serving the static fallback list`, error);
			}
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-workbuddy2api: loopback endpoint failed to start; providers not registered", error);
	});
}
//#endregion
export { Config, DEFAULT_WORKBUDDY_POOL_POLICY, FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_MODELS_GLOBAL, REGION_KEYS, WORKBUDDY2API_ACCOUNTS_REFRESH_PATH, WORKBUDDY2API_ACCOUNT_PARAM, WORKBUDDY2API_CHECKIN_PATH, WORKBUDDY2API_CREDITS_REFRESH_PATH, WORKBUDDY2API_GLOBAL_PROVIDER, WORKBUDDY2API_HOST_HEARTBEAT_FILENAME, WORKBUDDY2API_MODELS_REFRESH_PATH, WORKBUDDY2API_POOL_ACTION_PATH, WORKBUDDY2API_PROVIDER, WORKBUDDY2API_PROVIDERS, WORKBUDDY2API_PROVIDER_DISPLAY_NAME, WORKBUDDY2API_PROVIDER_DISPLAY_NAMES, WORKBUDDY2API_REGIONS, WORKBUDDY2API_REGION_PARAM, WORKBUDDY2API_SETTINGS_NS, WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY2API_USAGE_PATH, WORKBUDDY2API_VERSION, WORKBUDDY_AUTH_FILE_ENV, WorkBuddyAccountPool, WorkBuddyCatalog, WorkBuddyCredentialStore, WorkBuddyUpstreamClient, apply, applyContextBudgets, authFileName, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthDirs, defaultDesktopAuthPath, deriveCatalog, expiryToMs, fallbackModelsFor, inject, isFresher, isHeartbeatProcessAlive, name, nextDay4Am, parseCreditMultiplier, parseReasoning, parseUpstreamModel, parseWorkBuddyAuth, prepareChatBody, processStartTimeMs, readHostHeartbeat, regionOf, regionOfProvider, regionOfStatusUrl, regionStateOf, registerWorkBuddy2ApiStatusRoute, resolvePolicy, selectCliModels, stickyKeyOf, toPersistedWorkBuddyModel, withWorkBuddyRegion, workBuddyDisplayName, workBuddyModelInput, workBuddyThinkingLevelMap, workBuddyWebStatus, workbuddyAccountId, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, writeHostHeartbeat };
