import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { execFileSync } from "node:child_process";
//#region src/upstream.ts
/**
* WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
* token refresh, model catalog, credit balance, and daily check-in.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 本文件的 wire 行为逐项沿用该项目（其上游协议本身参照
*     Sliverkiss/workbuddy2api (MIT) 与 corrinehu/dsh-workbuddy-connect (MIT)）：
*     按 domain 选择 CN/global base、强制 stream:true、tool_choice 压平为
*     字符串、developer→system 角色改写、CLI 形态请求头、
*     chat 请求绝不携带 refresh token 的安全红线、中英文额度不足标记与
*     错误分类、token 刷新的 X-Refresh-Token 头、模型目录的两种文档形态、
*     积分套餐的月度/一次性判定。
* 改动：
*   1. 模型目录改为「双区域择新」——本插件同时持有两个区域的账号，
*      单一区域的目录会让另一区域的账号看不到自己的模型，因此按账号
*      所属区域取各自文档，并把两边的结果合并成一份目录（见
*      `WorkBuddyUpstreamClient.fetchModelsForAnyRegion`）；
*   2. 新增 `WorkBuddyModelCatalog`：账号池要为每个账号解析出可用模型
*     集合，因此把「解析 → 去重」独立成可复用的解析器；
*   3. 错误分类补上 `UpstreamErrorKind` 到账号池状态迁移所需的
*     判定（额度不足 / 会话失效 / 限流），供 pool 直接消费。
*
* @module dsh-workbuddy2api/upstream
*/
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Product origin (the growth centre and its reward endpoints live here). */
const CN_WEB_BASE = "https://www.workbuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** Growth-domain paths: the task list, registration, and the report channel. */
const TASKS_LIST_PATH = "/v2/activity/growth/tasks";
const TASKS_ACCEPT_PATH = "/v2/activity/growth/tasks/accept";
const REPORT_PATH = "/v2/report";
/** The platform expert market (desktop channel). */
const MARKET_EXPERT_PATH = "/portal/operation-platform/market/expert/list";
/** A real chat turn is capped: the sweep must not stall on a long answer. */
const CHAT_TURN_TIMEOUT_MS = 9e4;
/** Browser user agent used by the web-fingerprint report channel. */
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/** Model-catalog path used by the CN region. */
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/** Remote product-config path on the global gateway (desktop channel). */
const GLOBAL_CONFIG_PATH = "/v3/config";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** User agent of the WorkBuddy desktop app (see dsh-connect-workbuddy). */
const DESKTOP_UA = "WorkBuddy/5.5.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Region for a login domain; an empty domain means CN. The international
* product is reachable under TWO brand domains (`workbuddy.ai` desktop and
* `codebuddy.ai` CLI), both served by the same gateway stack.
*/
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
	return "cn";
}
/**
* Gateway for a global credential. International accounts are NOT
* interchangeable across brand domains, so the base follows the credential's
* OWN domain; anything unrecognised falls back to the desktop gateway.
*/
function globalBase(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
* force `stream: true` (the upstream rejects non-streaming), rewrite DSH's
* `developer` role to `system`, and flatten `tool_choice`.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		if (message["role"] === "developer") message["role"] = "system";
	}
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
/**
* Gateway (openresty/APISIX) rejection of a token it no longer accepts: the
* business APIs answer JSON, an edge rejection answers an HTML error page.
*/
function isGatewayAuthRejection(status, text) {
	if (status !== 401 && status !== 403) return false;
	const lower = text.toLowerCase();
	return lower.includes("openresty") || lower.includes("apisix") || lower.includes("authorization required");
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		if (isGatewayAuthRejection(response.status, text)) throw new Error(`workbuddy: the signed-in credential was rejected by the upstream gateway (http ${response.status}). The stored token is no longer accepted — most likely a stale credential file from an earlier sign-in was selected. Re-sign in to the WorkBuddy desktop app, then refresh the account pool in the plugin card.`);
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Parse the upstream's `credits` string into a multiplier. Observed forms:
* `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`, and absent. Unparsable
* values yield undefined rather than a guess.
*/
function parseCreditMultiplier(value) {
	if (typeof value !== "string") return void 0;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return void 0;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
/**
* The effort vocabulary the upstream's plural-form payloads declare across
* both gateways; the singular `effort` value is a DEFAULT, never the model's
* only level.
*/
const SINGULAR_EFFORT_LADDER = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** The singular spelling of reasoning metadata: `effort` and none of the plural fields. */
function isSingularEffortForm(raw) {
	return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
/** Fold a singular-form `effort` into the plural shape the rest of the plugin understands. */
function singularEffortLadder(raw) {
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	if (effort === void 0) return void 0;
	return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
function parseReasoning(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
	const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
	const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : isSingularEffortForm(raw) ? true : void 0;
	if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) return;
	return {
		...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...canDisableThinking === void 0 ? {} : { canDisableThinking }
	};
}
/** Parse one catalog entry; entries without usable token limits are dropped. */
function parseUpstreamModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return void 0;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return void 0;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const descriptionZh = typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : void 0;
	const descriptionEn = typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? raw["descriptionEn"] : void 0;
	const creditMultiplier = parseCreditMultiplier(raw["credits"]);
	const reasoning = parseReasoning(raw["reasoning"]);
	const supportsToolCall = typeof raw["supportsToolCall"] === "boolean" ? raw["supportsToolCall"] : void 0;
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		...reasoning === void 0 ? {} : { reasoning },
		...descriptionZh === void 0 ? {} : { descriptionZh },
		...descriptionEn === void 0 ? {} : { descriptionEn },
		...supportsToolCall === void 0 ? {} : { supportsToolCall }
	};
}
/**
* Select the chat-capable models from a catalog-shaped document: parse every
* entry, then keep the `cli` agent's roster in its declared order. Without a
* usable `cli` roster the whole parsed catalog is exposed rather than nothing.
*/
function selectCliModels(rawModels, agents) {
	const byId = /* @__PURE__ */ new Map();
	for (const model of Array.isArray(rawModels) ? rawModels : []) {
		const parsed = parseUpstreamModel(model);
		if (parsed !== void 0) byId.set(parsed.id, parsed);
	}
	let cliIds;
	for (const agent of Array.isArray(agents) ? agents : []) if (typeof agent === "object" && agent !== null) {
		const wrapped = agent;
		if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
			cliIds = wrapped["models"].filter((id) => typeof id === "string");
			break;
		}
	}
	const models = (cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()]).map((id) => byId.get(id)).filter((model) => model !== void 0);
	if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
	return models;
}
/**
* Parse one growth task. The progress shape varies by task type: some entries
* carry a nested `progress: {current,target}` object and others flat
* `current`/`target` fields, so both are read and the nested one wins when it
* carries a real value.
*/
function parseUpstreamTask(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const taskCode = typeof raw["task_code"] === "string" ? raw["task_code"] : "";
	if (taskCode === "") return void 0;
	const numberField = (source, key) => typeof source[key] === "number" ? source[key] : 0;
	let current = numberField(raw, "current");
	let target = numberField(raw, "target");
	const progress = raw["progress"];
	if (typeof progress === "object" && progress !== null && !Array.isArray(progress)) {
		const nested = progress;
		const nestedCurrent = numberField(nested, "current");
		const nestedTarget = numberField(nested, "target");
		if (nestedTarget > 0 || nestedCurrent > 0) {
			current = nestedCurrent;
			target = nestedTarget;
		}
	}
	const acceptStatus = typeof raw["accept_status"] === "string" ? raw["accept_status"] : void 0;
	const claimed = acceptStatus === "claimed";
	const text = (key) => typeof raw[key] === "string" && raw[key] !== "" ? raw[key] : void 0;
	const title = text("title");
	const description = text("description");
	const taskDesc = text("task_desc");
	const taskType = text("task_type");
	const tag = text("tag");
	const jumpUrl = text("jump_url");
	const status = text("status");
	return {
		taskCode,
		...title === void 0 ? {} : { title },
		...description === void 0 ? {} : { description },
		...taskDesc === void 0 ? {} : { taskDesc },
		credit: numberField(raw, "reward_credit"),
		energy: numberField(raw, "reward_energy"),
		hasReward: raw["has_reward"] === true,
		...taskType === void 0 ? {} : { taskType },
		...tag === void 0 ? {} : { tag },
		...jumpUrl === void 0 ? {} : { jumpUrl },
		locked: raw["locked"] === true,
		target,
		current,
		...acceptStatus === void 0 ? {} : { acceptStatus },
		...status === void 0 ? {} : { status },
		claimable: !claimed && target > 0 && current >= target,
		claimed
	};
}
/** Whether a moment falls in the night-owl scoring window (23:00–08:00 local). */
function isNightWindow(now = /* @__PURE__ */ new Date()) {
	const hour = now.getHours();
	return hour >= 23 || hour < 8;
}
/**
* Read the first server-minted request id out of an SSE stream, then abandon
* the rest of the body.
*
* The expert and skill tasks JOIN their events onto a real conversation, and
* the join key has to be the id the SERVER returned (`cmb-` + 32 hex, or 32
* bare hex). A locally invented id is accepted by `/v2/report` and then never
* scored, which is the failure this reader exists to prevent.
*/
async function readServerRequestId(response) {
	const body = response.body;
	if (body === null) return void 0;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (buffered.length < 1 << 20) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			const match = /"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/u.exec(buffered);
			if (match !== null) return match[1];
		}
		return;
	} finally {
		reader.cancel().catch(() => {});
	}
}
/** The desktop fingerprint every report event carries. */
function desktopFingerprint(credential) {
	const now = Date.now();
	const derive = (salt) => createHash("sha256").update(salt + ":" + credential.uid).digest("hex").slice(0, 36);
	return {
		timezone: "Asia/Shanghai",
		reportDelay: 2e3,
		userId: credential.uid,
		username: credential.nickname ?? "",
		userNickname: credential.nickname ?? "",
		product: "SaaS",
		releaseDate: 1789036585355,
		commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
		ideName: "WorkBuddy",
		ideType: "WorkBuddy",
		ideVersion: "5.5.6",
		machineId: derive("machine"),
		sessionId: derive("session"),
		extName: "workbuddy-desktop",
		extVersion: "5.5.6",
		os: "win32",
		arch: "x64",
		osVersion: "10.0.26220",
		cpuCores: 20,
		memorySize: 24,
		timestamp: now,
		presentAt: now
	};
}
/**
* Build the full chat_request_send event the desktop client sends. The minimal
* three-field shape is NOT accepted: the gateway answers 200 and silently drops
* an event whose field set or userId does not match the client's, which would
* make a task look "reported but never scored".
*/
function chatRequestEvent(credential, conversationId, requestId, modelId, modelName) {
	const now = Date.now();
	return {
		eventCode: "chat_request_send",
		timestamp: now,
		reportDelay: 0,
		mode: "craft",
		conversationId,
		requestId,
		inputLength: 12,
		requestModelId: modelId,
		requestModelName: modelName,
		isPlan: false,
		isAutoExecuteTerminal: false,
		isAutoModify: false,
		codebaseEnable: false,
		maxToken: 0,
		maxSteps: 0,
		temperature: 0,
		maxRetries: 0,
		mentionContexts: [],
		knowledgeId: [],
		knowledgeName: [],
		codebaseId: "",
		mentionContextCount: 0,
		command: "",
		expertId: "",
		recommendId: "",
		skillId: "",
		skillCount: 0,
		totalCount: 0,
		fileUri: "",
		presentAt: now,
		traceId: "",
		rootRequestId: requestId,
		parentConversationId: conversationId,
		agentName: "default",
		agentType: "conversation",
		userId: credential.uid
	};
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*/
var WorkBuddyUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* Read the model directory for the credential's region. CN answers
	* `/v2/enterprises/personal/models`; the global gateway answers `/v3/config`
	* for the desktop channel (its personal-models path returns HTTP 500 and the
	* CLI channel omits chat-usable models).
	*/
	async fetchModels(credential, signal) {
		const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS);
		if (regionOf(credential.domain) === "global") {
			const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Accept": "application/json",
					...credential.uid === "" ? {} : { "X-User-Id": credential.uid },
					...credential.domain === "" ? {} : { "X-Domain": credential.domain },
					"X-Product": "SaaS",
					"X-Requested-With": "XMLHttpRequest",
					"Connection": "close",
					"User-Agent": DESKTOP_UA
				},
				signal: timeout
			});
			const envelope = await readEnvelope(response);
			if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
			const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
			return selectCliModels(data["models"], data["agents"]);
		}
		const response = await fetch(`${chatBase(credential)}${MODELS_CATALOG_PATH}`, {
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json",
				"Origin": originReferer(credential),
				"Referer": `${originReferer(credential)}/`,
				"User-Agent": CLIENT_UA
			},
			signal: timeout
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return selectCliModels(data["models"], data["agents"]);
	}
	/**
	* Read ONE region's pooled accounts' directories and merge them into that
	* region's catalog.
	*
	* Every credential handed in must belong to the same region: this method
	* merges on model id, and the upstream reuses ids across regions for models
	* that are billed differently (`deepseek-v4.1-flash` is x0.00 on the
	* international gateway and x0.03 on the domestic one). Merging across
	* regions would therefore let one side's rate silently replace the other's,
	* which is exactly the bug the two-pool split exists to prevent. The region is
	* asserted rather than assumed so a caller mistake fails loudly.
	*
	* Accounts are queried in parallel and a failing account never fails the
	* merge: the catalog is what the pool can actually serve, so one expired
	* sign-in must not blank the model picker. When EVERY account fails the first
	* real cause is thrown instead of returning an empty catalog.
	*/
	async fetchModelsForCredentials(credentials, signal) {
		if (credentials.length === 0) throw new Error("workbuddy: no signed-in account to read a model catalog from");
		const regions = new Set(credentials.map((credential) => regionOf(credential.domain)));
		if (regions.size > 1) throw new Error(`workbuddy: refusing to merge model catalogs across regions (${[...regions].join(", ")}); each region owns a separate pool and a separate directory`);
		const settled = await Promise.allSettled(credentials.map((credential) => this.fetchModels(credential, signal)));
		const byId = /* @__PURE__ */ new Map();
		for (const result of settled) {
			if (result.status !== "fulfilled") continue;
			for (const model of result.value) if (!byId.has(model.id)) byId.set(model.id, model);
		}
		if (byId.size === 0) {
			const failure = settled.find((result) => result.status === "rejected");
			throw failure !== void 0 && failure.status === "rejected" ? failure.reason : /* @__PURE__ */ new Error("workbuddy: every account returned an empty model catalog");
		}
		return [...byId.values()];
	}
	/** Query today's check-in status without changing account state. */
	async fetchCheckinStatus(credential) {
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			active: data["active"] === true,
			todayCheckedIn: data["today_checked_in"] === true,
			streakDays: numberField("streak_days"),
			dailyCredit: numberField("daily_credit"),
			todayCredit: numberField("today_credit"),
			isStreakDay: data["is_streak_day"] === true,
			nextStreakDay: numberField("next_streak_day"),
			streakBonusDays: numberField("streak_bonus_days"),
			streakBonusCredit: numberField("streak_bonus_credit"),
			...typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== "" ? { claimButtonText: data["claim_button_text"] } : {}
		};
	}
	/** Claim today's check-in reward. The browser route guards this mutation. */
	async claimDailyCheckin(credential) {
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			credit: numberField("credit"),
			streakDays: numberField("streak_days"),
			isStreakDay: data["is_streak_day"] === true
		};
	}
	/**
	* POST the billing endpoint for the remaining credit, keeping every package
	* separate: the card groups monthly-cycle packages itself and lists the
	* nearest-expiring one-off packages, so aggregation here would lose the
	* dates it needs.
	*/
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		let total = 0;
		let nearestExpiryMs;
		let expiringSoon = 0;
		const SOON_MS = 2592e5;
		const parseDate = (raw) => {
			if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
			if (typeof raw === "string" && raw !== "") {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) return parsed;
			}
		};
		const packages = [];
		let capacity = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const monthly = numberField("CapacityType") === 4;
			const size = monthly ? numberField("CycleCapacitySize") : numberField("CapacitySize");
			const remain = monthly ? numberField("CycleCapacityRemain") : numberField("CapacityRemain");
			const cappedRemain = remain < 0 ? 0 : remain;
			const cycleEndMs = parseDate(account["CycleEndTime"]);
			const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
			const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
			if (!monthly && (cappedRemain <= 0 || expiresAtMs !== void 0 && expiresAtMs <= Date.now())) continue;
			total += cappedRemain;
			capacity += size;
			const expiryMs = expiresAtMs;
			if (expiryMs !== void 0) {
				if (nearestExpiryMs === void 0 || expiryMs < nearestExpiryMs) nearestExpiryMs = expiryMs;
				if (expiryMs - Date.now() <= SOON_MS) expiringSoon += cappedRemain;
			}
			packages.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain: cappedRemain,
				size,
				monthly,
				...refreshAtMs === void 0 ? {} : { refreshAtMs },
				...expiresAtMs === void 0 ? {} : { expiresAtMs }
			});
		}
		return {
			total,
			capacity,
			packages,
			expiringSoon,
			...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
		};
	}
	/**
	* Read the growth task list. This is the whole task surface: accept, claim,
	* and every "did it score yet" read all key off it.
	*/
	async listTasks(credential, signal) {
		const response = await fetch(chatBase(credential) + TASKS_LIST_PATH, {
			headers: {
				...billingHeaders(credential),
				"Accept": "application/json"
			},
			signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const raw = Array.isArray(data["tasks"]) ? data["tasks"] : [];
		const tasks = [];
		for (const entry of raw) {
			const parsed = parseUpstreamTask(entry);
			if (parsed !== void 0) tasks.push(parsed);
		}
		return tasks;
	}
	/** Register for tasks (idempotent: an already-accepted task is not an error). */
	async acceptTasks(credential, taskCodes) {
		if (taskCodes.length === 0) return;
		const response = await fetch(chatBase(credential) + TASKS_ACCEPT_PATH, {
			method: "POST",
			headers: {
				...billingHeaders(credential),
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ task_codes: [...taskCodes] }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Take one task's reward.
	*
	* The path matters and is NOT the CLI one: the reward endpoint lives on the
	* WEB origin (`workbuddy.cn/activity/growth/tasks/<code>/claim`, task code in
	* the path, `x-client-platform: web`). The CLI-shaped
	* `copilot.tencent.com/v2/activity/growth/tasks/reward/claim` does not exist
	* and answers "task not completed" for every task.
	*/
	async claimTaskReward(credential, taskCode) {
		const base = regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_WEB_BASE;
		const response = await fetch(base + "/activity/growth/tasks/" + encodeURIComponent(taskCode) + "/claim", {
			method: "POST",
			headers: {
				"Authorization": "Bearer " + credential.accessToken,
				"Accept": "application/json, text/plain, */*",
				"Content-Type": "application/json",
				"Origin": base,
				"Referer": base + "/profile/growth-center",
				"x-client-platform": "web",
				...credential.uid === "" ? {} : { "X-User-Id": credential.uid },
				...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? {} : {
					"X-Enterprise-Id": credential.enterpriseId,
					"X-Tenant-Id": credential.enterpriseId
				},
				...credential.domain === "" ? {} : { "X-Domain": credential.domain }
			},
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return data["already_claimed"] === true ? {
			credit: 0,
			energy: 0,
			alreadyClaimed: true
		} : {
			credit: numberField("credit"),
			energy: numberField("energy"),
			alreadyClaimed: false
		};
	}
	/**
	* Report one conversation-activity event (chat_request_send). This is what
	* actually lights up most tasks — registering for a task produces no
	* progress; the gateway scores behavior events.
	*/
	async reportChatActivity(credential, conversationId, requestId, model) {
		const event = chatRequestEvent(credential, conversationId, requestId === "" ? conversationId : requestId, model?.id ?? "deepseek-v4-flash", model?.name ?? "DeepSeek V4 Flash");
		await this.reportEvents(credential, CN_BILLING_BASE, [event], "cli");
	}
	/** Report desktop-fingerprint events to the chat origin's /v2/report. */
	async reportDesktopEvents(credential, events) {
		if (events.length === 0) return;
		const fingerprint = desktopFingerprint(credential);
		const payload = events.map((event) => ({
			...fingerprint,
			...event
		}));
		await this.reportEvents(credential, chatBase(credential), payload, "desktop");
	}
	/** Report web-fingerprint events to the product's own origin. */
	async reportWebEvents(credential, events) {
		if (events.length === 0) return;
		const base = regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_WEB_BASE;
		await this.reportEvents(credential, base, events, "web");
	}
	/**
	* POST one batch of events. The three channels differ only in origin and
	* headers: the CLI/billing channel authenticates with the billing headers,
	* the desktop one mimics the app, and the web one mimics the growth centre.
	*/
	async reportEvents(credential, base, events, channel) {
		const headers = channel === "cli" ? {
			...billingHeaders(credential),
			"Content-Type": "application/json"
		} : channel === "desktop" ? {
			"Authorization": "Bearer " + credential.accessToken,
			"Accept": "application/json, text/plain, */*",
			"Content-Type": "application/json;charset=UTF-8",
			"User-Agent": DESKTOP_UA,
			"X-Domain": base,
			"X-Product": "SaaS",
			"X-Request-ID": createHash("sha256").update("req:" + credential.uid).digest("hex").slice(0, 36) + String(Date.now() % 1e6),
			...credential.uid === "" ? {} : { "X-User-Id": credential.uid }
		} : {
			"Authorization": "Bearer " + credential.accessToken,
			"Content-Type": "application/json",
			"Accept": "application/json",
			"x-client-platform": "web",
			"Origin": base,
			"Referer": base + "/",
			"User-Agent": WEB_UA,
			...credential.uid === "" ? {} : { "X-User-Id": credential.uid }
		};
		const response = await fetch(base + REPORT_PATH, {
			method: "POST",
			headers,
			body: JSON.stringify(events),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* Read the platform's real expert market. The ids must be REAL: an invented
	* expert id never counts toward the expert tasks, which is why the market is
	* listed instead of hard-coding names.
	*/
	async marketExpertList(credential, expertType) {
		const response = await fetch(chatBase(credential) + MARKET_EXPERT_PATH, {
			method: "POST",
			headers: {
				"Authorization": "Bearer " + credential.accessToken,
				"Content-Type": "application/json",
				"User-Agent": DESKTOP_UA,
				"X-Domain": chatBase(credential),
				"X-Product": "SaaS",
				...credential.uid === "" ? {} : { "X-User-Id": credential.uid }
			},
			body: JSON.stringify({
				page: 1,
				page_size: 20,
				sort_by: "reco_rank",
				sort_order: "desc",
				expert_type: expertType
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const raw = Array.isArray(data["experts"]) ? data["experts"] : [];
		const experts = [];
		for (const entry of raw) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry;
			const expertId = typeof record["expert_id"] === "string" ? record["expert_id"] : "";
			if (expertId === "") continue;
			experts.push({
				expertId,
				expertType: typeof record["expert_type"] === "string" ? record["expert_type"] : expertType,
				name: typeof record["display_name_zh"] === "string" ? record["display_name_zh"] : expertId,
				profession: typeof record["profession_zh"] === "string" ? record["profession_zh"] : "",
				version: typeof record["version"] === "string" && record["version"] !== "" ? record["version"] : "1.0.0",
				category: Array.isArray(record["categories"]) && typeof record["categories"][0] === "string" ? record["categories"][0] : "expert-all"
			});
		}
		return experts;
	}
	/**
	* Send one real chat turn in the desktop app's shape and read the SERVER's
	* request id out of the SSE stream.
	*
	* The expert/skill tasks are scored on events that JOIN a real conversation,
	* and the join key must be the id the server minted — a locally generated
	* UUID does not count. So this streams (and drains) the answer just far
	* enough to capture `data.id`, then stops caring about the content.
	*/
	async desktopChatTurn(credential, options = {}) {
		const conversationId = "wb2api-conv-" + String(Date.now()) + "-" + Math.floor(Math.random() * 1e6).toString(36);
		const model = options.model ?? "fast-model";
		const response = await fetch(chatBase(credential) + "/v2/chat/completions", {
			method: "POST",
			headers: {
				"Authorization": "Bearer " + credential.accessToken,
				"Content-Type": "application/json",
				"Accept": "text/event-stream",
				"User-Agent": DESKTOP_UA,
				"X-Domain": chatBase(credential),
				"X-Product": "SaaS",
				"X-User-Id": credential.uid,
				"X-Conversation-ID": conversationId,
				"X-Request-ID": String(Date.now()),
				"X-Agent-Intent": "craft",
				"X-Agent-Type": "main",
				"X-IDE-Name": "WorkBuddy",
				"X-IDE-Type": "WorkBuddy",
				"X-IDE-Version": "5.5.6",
				"x-codebuddy-request": "1",
				...options.expertId === void 0 || options.expertId === "" ? {} : { "X-Expert-Id": options.expertId }
			},
			body: JSON.stringify({
				model,
				messages: [{
					role: "system",
					content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。"
				}, {
					role: "user",
					content: options.prompt ?? "1+1等于几？直接回答。"
				}],
				agent: "cli",
				temperature: 1,
				stream: true,
				stream_options: { include_usage: true }
			}),
			signal: AbortSignal.timeout(CHAT_TURN_TIMEOUT_MS)
		});
		if (!response.ok) {
			const text = (await response.text()).slice(0, 200);
			throw new Error("workbuddy desktop chat: http " + String(response.status) + " " + text);
		}
		const requestId = await readServerRequestId(response);
		if (requestId === void 0) throw new Error("workbuddy desktop chat: the stream carried no server request id");
		return {
			conversationId,
			requestId
		};
	}
	/** Claim the one-off newcomer gift. Re-claiming answers a business error. */
	async claimGift(credential) {
		const envelope = await this.billingJson(credential, "/billing/meter/claim-gift", {});
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return typeof data["credit"] === "number" ? data["credit"] : 0;
	}
	/** Agree to the buddy programme terms. Idempotent. */
	async buddyAgreement(credential) {
		await this.growthJson(credential, "POST", "/activity/growth/buddy/agreement", { agree: true });
	}
	/**
	* Adopt the first buddy. Before the daily-activity threshold is met the
	* gateway answers HTTP 400 with `first_buddy task not completed yet`; that is
	* an expected "not yet", not a failure, so it is reported as such.
	*/
	async buddyFirst(credential) {
		try {
			await this.growthJson(credential, "POST", "/activity/growth/buddy/first", {});
			return {
				adopted: true,
				message: "已领取 Buddy（+300 分 +8 能量）"
			};
		} catch (error) {
			if ((error instanceof Error ? error.message : String(error)).toLowerCase().includes("first_buddy task not completed yet")) return {
				adopted: false,
				message: "前置已上报，但领养门槛未过（上游要求当日活跃），稍后会自动重试"
			};
			throw error;
		}
	}
	/** One POST to the growth domain, envelope unwrapped. */
	async growthJson(credential, method, path, body) {
		const response = await fetch(chatBase(credential) + path, {
			method,
			headers: {
				...billingHeaders(credential),
				"Content-Type": "application/json"
			},
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
	}
	/** One POST to the billing domain, envelope unwrapped. */
	async billingJson(credential, path, body) {
		const response = await fetch(billingBase(credential) + path, {
			method: "POST",
			headers: {
				...billingHeaders(credential),
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return { data: envelope.data };
	}
};
//#endregion
//#region src/auth.ts
/**
* WorkBuddy credential discovery, parsing, and the multi-account credential
* registry.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 本文件在「账号发现」这一层沿用其全部已验证做法：桌面端 auth 文件
*     只读、刷新结果写入 $DSH_HOME 自有副本、按 uin 去重的多账号目录扫描、
*     「live 文件 > lastRefreshTime > expiresAt」的三级择新排序、
*     按需刷新（5 分钟余量）与单飞去重、刷新失败但 token 未过期则沿用旧
*     token、平台路径候选（macOS / Windows Local+Roaming / Linux XDG）
*     与环境变量覆盖。其又源自 corrinehu/dsh-workbuddy-connect（MIT）。
* 改动：
*   1. 不再按区域拆成两个 store —— 本插件把区域当成「账号的属性」，
*      一个 store 管理全部账号，pool 负责在它们之间调度；
*   2. 新增「多账号各自持有独立 token 副本」的持久化：每个账号一个
*      `$DSH_HOME/.workbuddy2api-auth.<accountId>.json` 文件，因此 N 个账号
*      同时在线互不覆盖（原实现每区域只能存一个刷新结果）；
*   3. 新增 `refreshCredential(accountId)` 与 `byIds()`：账号池需要
*      按 id 定位并刷新任意一个账号，而不是只解析「当前选中的那个」；
*   4. 新增 `region` 过滤：每个账号池只看得见自己区域的账号，
*      两个区域因此是两个互不可见的账号集合。
*
* @module dsh-workbuddy2api/auth
*/
/** Basename of the live WorkBuddy desktop auth file. */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Prefix of the per-account plugin-owned credential copies. */
const OWN_PREFIX = ".workbuddy2api-auth";
/** Current on-disk format of a plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/**
* Plugin-owned copy path for one account inside the Harness home. One file per
* account id means N simultaneously signed-in accounts never overwrite each
* other's refreshed token — the property the pool depends on.
*/
function workbuddyOwnAuthPath(accountId, storeDir = resolveDshHome()) {
	return join(storeDir, `${OWN_PREFIX}.${accountId}.json`);
}
/**
* Platform-default directories holding the WorkBuddy desktop app's auth file.
*
* Windows and Linux prefer the OS-issued env location and fall back to the
* home-derived convention when it is unset, so a redirected profile (OneDrive
* folder backup, enterprise policy) still resolves. macOS has no equivalent
* env variable; the single Application Support path is used as-is.
*/
function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
	if (platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		const roaming = nonEmptyEnv(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth"), join(roaming, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}
/** A non-empty, trimmed env value, or undefined when unset/blank. */
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** The live auth file's platform candidates, in probe order. */
function defaultDesktopAuthCandidates() {
	return defaultDesktopAuthDirs().map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME));
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath() {
	return defaultDesktopAuthCandidates()[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** The first of two spellings that holds a number, in priority order. */
function numberField(source, ...keys) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number") return value;
	}
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAuth(text, filePath) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : auth;
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = expiryToMs(numberField(auth, "expiresAt", "expiresAtMs") ?? 0);
	const refreshExpiresAt = numberField(auth, "refreshExpiresAt", "refreshExpiresAtMs");
	const refreshExpiresAtMs = refreshExpiresAt === void 0 ? void 0 : expiryToMs(refreshExpiresAt);
	const lastRefresh = numberField(auth, "lastRefreshTime", "lastRefreshAtMs");
	const lastRefreshAtMs = lastRefresh === void 0 ? void 0 : expiryToMs(lastRefresh);
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	const uin = optionalString(identity["uin"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		...uin === void 0 ? {} : { uin },
		...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
		source: "desktop",
		filePath
	};
}
/**
* Filename of a path regardless of the host separator: Windows paths use `\`
* and this helper must keep working when a Windows path is compared on a
* POSIX host (e.g. tests injecting a Windows-style auth dir).
*/
function authFileName(path) {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separator === -1 ? path : path.slice(separator + 1);
}
/**
* Rank two candidate files for the same account.
*
* The live `workbuddy-desktop.info` always wins: it is the app's current
* sign-in, and the upstream revokes the tokens in the timestamped backups even
* though their stored `expiresAt` is still in the future. Expiry is therefore
* only a tie-breaker among backups, never the primary ordering.
*/
function fileRank(path) {
	return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1;
}
/**
* Whether `candidate` is a better pick than `incumbent` for the same account.
* Ordering, strongest signal first: the live file; then the most recent
* `lastRefreshAtMs` (the upstream's own issuance time); then `expiresAtMs`
* as a fallback for documents that omit the field.
*/
function isFresher(candidate, incumbent) {
	const rankDiff = fileRank(candidate.filePath) - fileRank(incumbent.filePath);
	if (rankDiff !== 0) return rankDiff < 0;
	const candidateRefresh = candidate.lastRefreshAtMs;
	const incumbentRefresh = incumbent.lastRefreshAtMs;
	if (candidateRefresh !== void 0 && incumbentRefresh !== void 0) {
		if (candidateRefresh !== incumbentRefresh) return candidateRefresh > incumbentRefresh;
	} else if (candidateRefresh !== void 0) return true;
	else if (incumbentRefresh !== void 0) return false;
	return candidate.expiresAtMs > incumbent.expiresAtMs;
}
/**
* Stable account id. `uin` is the billing identity the upstream keys on and
* survives across re-login; `uid` is the fallback for documents without one.
*/
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 24);
}
/** Serialize the plugin-owned copy. */
function ownDocument(credential, accountId) {
	return {
		version: OWN_FORMAT_VERSION,
		accountId,
		credential
	};
}
/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text, filePath) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document["credential"] }), filePath);
	if (credential === void 0) return void 0;
	return {
		...credential,
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/** Read one auth file, tolerating absence and unparsable content. */
async function readAuthFile(path) {
	try {
		return parseWorkBuddyAuth(await readFile(path, "utf8"), path);
	} catch (error) {
		if (isENOENT(error)) return void 0;
		return;
	}
}
/**
* Read-only credential registry with demand-driven refresh and multi-account
* discovery.
*
* Refresh policy: refresh only when the access token is inside the margin (or
* already expired), keep the refreshed credential in the account's own
* plugin-owned copy, and never write the desktop app's files. A failed refresh
* still returns a not-yet-expired token so an unreachable refresh endpoint does
* not take down a working session.
*/
var WorkBuddyCredentialStore = class {
	refresh;
	refreshMarginMs;
	authDirs;
	storeDir;
	region;
	desktopPathOverride;
	/** In-flight refresh per account id; concurrent callers share one request. */
	inflight = /* @__PURE__ */ new Map();
	constructor(options) {
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.authDirs = options.authDirs;
		this.storeDir = options.storeDir ?? resolveDshHome();
		this.region = options.region;
		this.desktopPathOverride = options.desktopPath;
	}
	/** Whether a credential's login domain belongs to this store's region. */
	matchesRegion(domain) {
		return this.region === void 0 || regionOf(domain) === this.region;
	}
	/** The region this store serves, when it is region-scoped. */
	regionOf() {
		return this.region;
	}
	/** Repoint the desktop file or directory; applies on the next read. */
	setDesktopPath(path) {
		this.desktopPathOverride = path;
		this.inflight.clear();
	}
	/** The auth-file path candidates, in probe order. */
	resolveDesktopCandidates() {
		const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultDesktopAuthCandidates();
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/**
	* Every auth file to scan: the live file plus the timestamped backups
	* WorkBuddy leaves beside it.
	*
	* An explicitly configured path pins the *directory*: its siblings are still
	* scanned, because a user who points the plugin at their auth file expects
	* account switching to work the same way it does on the default path. Only
	* the file ordering changes.
	*/
	async candidateFiles() {
		const explicitPath = this.desktopPathOverride ?? ((process.env["WORKBUDDY_AUTH_FILE"] ?? "").trim() !== "" ? process.env["WORKBUDDY_AUTH_FILE"] : void 0);
		const files = [];
		if (explicitPath !== void 0) {
			files.push(explicitPath);
			for (const backup of await this.backupsBeside(explicitPath)) files.push(backup);
			return files;
		}
		const dirs = this.authDirs ?? defaultDesktopAuthDirs();
		for (const dir of dirs) {
			const live = join(dir, WORKBUDDY_LIVE_FILENAME);
			files.push(live);
			for (const backup of await this.backupsBeside(live)) files.push(backup);
		}
		return files;
	}
	/** Timestamped siblings of one auth file, newest first by filename. */
	async backupsBeside(path) {
		const dir = dirname(path);
		const base = path.slice(dir.length + 1);
		try {
			return (await readdir(dir)).filter((name) => name !== base && name.endsWith(".info")).sort().reverse().map((name) => join(dir, name));
		} catch {
			return [];
		}
	}
	/** Every plugin-owned copy currently on disk, keyed by account id. */
	async readOwns() {
		const copies = /* @__PURE__ */ new Map();
		let entries;
		try {
			entries = await readdir(this.storeDir);
		} catch {
			return copies;
		}
		for (const name of entries) {
			if (!name.startsWith(`${OWN_PREFIX}.`) || !name.endsWith(".json")) continue;
			const path = join(this.storeDir, name);
			try {
				const parsed = parseOwnDocument(await readFile(path, "utf8"), path);
				if (parsed === void 0) continue;
				copies.set(workbuddyAccountId(parsed), parsed);
			} catch {}
		}
		return copies;
	}
	/**
	* Read every local credential, deduplicated by account id. Files are probed
	* newest-first, so the first entry for an account is its freshest. Every
	* account — both regions — is returned: the pool decides which ones to use.
	*/
	async readAll() {
		const files = await this.candidateFiles();
		const byId = /* @__PURE__ */ new Map();
		for (const file of files) {
			const credential = await readAuthFile(file);
			if (credential === void 0 || !this.matchesRegion(credential.domain)) continue;
			const id = workbuddyAccountId(credential);
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, credential);
				continue;
			}
			if (isFresher(credential, existing)) byId.set(id, credential);
		}
		const now = Date.now();
		for (const [id, own] of await this.readOwns()) {
			if (!this.matchesRegion(own.domain)) continue;
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, own);
				continue;
			}
			if (own.lastRefreshAtMs !== void 0 && own.lastRefreshAtMs > (existing.lastRefreshAtMs ?? 0)) {
				byId.set(id, own);
				continue;
			}
			if (own.expiresAtMs <= existing.expiresAtMs) continue;
			const dueForRefresh = existing.expiresAtMs <= 0 || existing.expiresAtMs <= now + this.refreshMarginMs;
			if (fileRank(existing.filePath) !== 0 || dueForRefresh) byId.set(id, own);
		}
		return [...byId.values()];
	}
	/** Token-free account list for the plugin card, in discovery order. */
	async accounts() {
		return (await this.readAll()).map((credential) => ({
			id: workbuddyAccountId(credential),
			accountName: credential.nickname ?? credential.uin ?? credential.uid,
			...credential.uin === void 0 ? {} : { uin: credential.uin },
			domain: credential.domain,
			region: regionOf(credential.domain),
			source: credential.source,
			tokenExpiresAtMs: credential.expiresAtMs,
			filePath: credential.filePath
		}));
	}
	/** The freshest stored credential for one account id, no refresh. */
	async current(accountId) {
		return (await this.readAll()).find((credential) => workbuddyAccountId(credential) === accountId);
	}
	/**
	* Every requested credential that is present locally, in the order asked.
	* Ids with no local credential are dropped: the pool must be able to tell
	* "this account vanished" from "this account is unhealthy".
	*/
	async byIds(accountIds) {
		const credentials = await this.readAll();
		const byId = new Map(credentials.map((credential) => [workbuddyAccountId(credential), credential]));
		return accountIds.flatMap((id) => {
			const credential = byId.get(id);
			return credential === void 0 ? [] : [credential];
		});
	}
	/** The credential to send upstream for one account: {@link current}, refreshed on demand. */
	async resolve(accountId) {
		const credential = await this.current(accountId);
		if (credential === void 0) throw new Error(`workbuddy: no signed-in WorkBuddy account found for ${accountId}; sign in once in the WorkBuddy desktop app (expected ${this.resolveDesktopCandidates().join(" or ") || "(no desktop path on this platform)"} or ${WORKBUDDY_AUTH_FILE_ENV}), or refresh the account pool in the plugin card`);
		if (!this.needsRefresh(credential)) return credential;
		const existing = this.inflight.get(accountId);
		if (existing !== void 0) return existing;
		const pending = this.refreshNow(credential).finally(() => {
			this.inflight.delete(accountId);
		});
		this.inflight.set(accountId, pending);
		return pending;
	}
	/** Read-only sign-in summary for one account; never refreshes and never throws. */
	async status(accountId) {
		try {
			const credential = await this.current(accountId);
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/**
	* Remove every plugin-owned copy this store wrote; the desktop files are
	* untouched. `logout` is the user's "forget what the plugin stored" action,
	* not a per-account toggle, so every per-account copy is cleared.
	*/
	async logout() {
		let entries;
		try {
			entries = await readdir(this.storeDir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!name.startsWith(`${OWN_PREFIX}.`) || !name.endsWith(".json")) continue;
			const path = join(this.storeDir, name);
			await rm(path, { force: true });
			await rm(`${path}.lock`, { force: true });
		}
	}
	/** Whether any desktop candidate file exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const path of this.resolveDesktopCandidates()) try {
			if ((await stat(path)).isFile()) return true;
		} catch {}
		return false;
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); open the WorkBuddy desktop app once to sign in again`);
		}
	}
	/**
	* Persist a credential the plugin obtained ITSELF — currently only through
	* the card's web sign-in. It lands in this store's own per-account copy, so
	* the pool treats it exactly like a discovered desktop sign-in, and the
	* desktop app's files stay untouched.
	*
	* A credential for the other region is refused rather than stored: the two
	* regions are two separate pools, and a mis-filed account would appear in
	* the wrong tab and be billed through the wrong gateway.
	*/
	async save(credential) {
		if (!this.matchesRegion(credential.domain)) throw new Error(`workbuddy: refusing to store a ${regionOf(credential.domain)} credential in the ${this.region ?? "shared"} store`);
		const stored = {
			...credential,
			source: "dsh"
		};
		await this.saveOwn(stored);
		this.inflight.delete(workbuddyAccountId(stored));
		return stored;
	}
	/**
	* Adopt the local identity of an already-known account when a freshly
	* obtained credential for that same account omits fields the local copy
	* carries. The sign-in endpoint answers `uid` and `nickname` but not the
	* billing `uin` the desktop files hold, and the account id is derived from
	* `uin` first — so without this the same human would occupy two pool
	* entries, one of which the desktop app keeps refreshing.
	*/
	async reconcileIdentity(credential) {
		if (!this.matchesRegion(credential.domain)) return credential;
		if (credential.uid === "" && credential.nickname === void 0) return credential;
		const known = (await this.readAll()).find((existing) => credential.uid !== "" && existing.uid === credential.uid || credential.nickname !== void 0 && existing.nickname === credential.nickname);
		if (known === void 0) return credential;
		return {
			...credential,
			...credential.uin === void 0 && known.uin !== void 0 ? { uin: known.uin } : {},
			...credential.enterpriseId === void 0 && known.enterpriseId !== void 0 ? { enterpriseId: known.enterpriseId } : {}
		};
	}
	async saveOwn(credential) {
		const accountId = workbuddyAccountId(credential);
		const path = workbuddyOwnAuthPath(accountId, this.storeDir);
		await withFileLock(path, async () => {
			await writeFileAtomic(path, `${JSON.stringify(ownDocument(credential, accountId), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
};
//#endregion
//#region src/catalog.ts
/**
* Static CLI models captured from the CN endpoint (2026-08-30). The upstream
* refresh replaces this list at startup; it exists so the provider registers
* with a usable catalog even while the first fetch is in flight or offline.
*/
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "auto",
		name: "Auto",
		contextWindow: 168e3,
		maxTokens: 32e3
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3
	},
	{
		id: "deepseek-v4-flash",
		name: "Deepseek-V4-Flash",
		contextWindow: 1e6,
		maxTokens: 5e4
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 5e4
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: .03
	}
];
/**
* Static CLI models captured from the INTERNATIONAL gateway's desktop-channel
* product config (`www.workbuddy.ai/v3/config`, 2026-09-11). The two regions
* expose different rosters, so a global account must never be seeded with the
* CN list.
*/
const FALLBACK_WORKBUDDY_MODELS_GLOBAL = [
	{
		id: "default-model",
		name: "Auto",
		contextWindow: 176e3,
		maxTokens: 24e3,
		creditMultiplier: .79
	},
	{
		id: "fast-model",
		name: "Fast",
		contextWindow: 2e5,
		maxTokens: 32e3,
		creditMultiplier: .34
	},
	{
		id: "balanced-model",
		name: "Balanced",
		contextWindow: 256e3,
		maxTokens: 32e3,
		creditMultiplier: .59
	},
	{
		id: "primary-model",
		name: "Primary",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 3.31
	},
	{
		id: "deep-model",
		name: "Deep",
		contextWindow: 176e3,
		maxTokens: 24e3,
		creditMultiplier: 3.33
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 0
	},
	{
		id: "deepseek-v4.1-flash-sg",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: .03
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 6.67
	},
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		creditMultiplier: 0
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 3.47
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 1.39
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: .14
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 3.31
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 1.65
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 1.25
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 65536,
		creditMultiplier: .99
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		creditMultiplier: 1.62
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		creditMultiplier: .79
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		creditMultiplier: .52
	}
];
/**
* Static fallback directory for one region. Each region's provider must never be
* seeded with the other region's roster: the two gateways can bill the same id
* differently, so a shared list would misreport rates before the first refresh.
*/
function fallbackModelsFor(region) {
	return region === "global" ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS;
}
/** Apply the saved local DSH budget; models above 200K default to 200K. */
function applyContextBudgets(catalog, budgets = {}) {
	return catalog.map((model) => ({
		...model,
		contextWindow: model.contextWindow > 2e5 ? Math.min(model.contextWindow, budgets[model.id] ?? 2e5) : model.contextWindow
	}));
}
/**
* Derive one region's runtime catalog from its last-refreshed directory plus the
* user's selection within that region. An empty selection falls back to the
* whole directory: a plugin that has never been configured must still serve
* models rather than nothing.
*/
function deriveCatalog(catalog, enabled, budgets = {}) {
	return applyContextBudgets(enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id)), budgets);
}
/** Mutable catalog shared by one region's shim `/v1/models` and its adapter. */
var WorkBuddyCatalog = class {
	models;
	/**
	* @param region Seeds the static fallback for THIS region, so the provider has
	* a usable roster from the first moment without borrowing the other side's.
	*/
	constructor(region = "cn") {
		this.models = fallbackModelsFor(region);
	}
	/** Current entries; the fallback list until the upstream answer lands. */
	current() {
		return this.models;
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		if (models.length === 0) throw new Error("workbuddy model catalog cannot be empty");
		this.models = models.map((model) => ({ ...model }));
	}
};
//#endregion
//#region src/pool.ts
/**
* Multi-account pool: account health state, weighted pick, session stickiness,
* cooldown/breaker/degrade transitions, and credit-aware ordering.
*
* 参考：Sliverkiss/workbuddy2api（MIT）— 本模块是该项目账号池
*   （`internal/pool/` + `internal/session/`）在单进程 Node 下的移植，
*   机制与默认值逐项对齐：
*     1. 四维正交状态机（禁用 / 冷却 / 熔断 / 降权）与 `healthy()` 或门；
*     2. 选号 = 「候选过滤 → 全冷却兜底 → 权重 → Top5 截断 → 防撞号 →
*        加权随机，全撞号时按单调序号 LRU 兜底」；
*     3. 权重三因子：余额占比 ×10、快过期占比 ×8、闲置补偿 0.5/h 封顶 5；
*     4. 失败分类迁移：额度不足 → 次日 04:00 硬冷却；限流 → 600s 基数、
*        指数退避封顶 2h，且「已在软冷却中不推进不延长」；连续失败达 3 次
*        熔断（30m 起、翻倍封顶 6h）；无分类的失败（传输层/未知 4xx）
*        连败 5 次降权 10m（封顶 2h）；
*     5. 会话粘性：同一会话固定同一账号，TTL 30m 滚动续期，GC 5m。
*   简化（单进程、无 Redis、无外部调度）：
*     - 不实现 realm 分池的快照镜像与跨进程恢复，状态落在 DSH settings；
*     - 不实现签到/旅行/夜猫子等额度增益排程（那是服务端职责）；
*     - 模型级冷却退化为账号级（本插件的模型目录是多账号合并的，
*       按模型冷却会让一个账号的坏模型影响整池选号）；
*     - `inFlight` 用普通计数器（Node 单线程无竞态），保留 Acquire/Release
*       语义与「选中即占名额、函数出口释放」模式；
*     - 时间来源与随机数可注入，便于测试确定化。
*
* @module dsh-workbuddy2api/pool
*/
/** The workbuddy2api-derived default policy. */
const DEFAULT_WORKBUDDY_POOL_POLICY = {
	maxInFlightPerAccount: 3,
	maxInFlightGlobalPerAccount: 2,
	maxInFlightTotal: 8,
	softRateCooldownMs: 6e5,
	softRateCooldownMaxMs: 72e5,
	notFoundCooldownMs: 6e4,
	breakerThreshold: 3,
	breakerCooldownMs: 18e5,
	breakerCooldownMaxMs: 216e5,
	degradeThreshold: 5,
	degradeCooldownMs: 6e5,
	degradeCooldownMaxMs: 72e5,
	stickyTtlMs: 18e5,
	stickyGcIntervalMs: 3e5,
	balanceAware: true,
	idleWeightPerHour: .5,
	idleWeightMax: 5,
	expiringWeight: 8,
	expiringSoonMs: 6048e5,
	minPickGapMs: 100
};
/**
* Session-stickiness key for one chat request.
*
* DSH identifies a conversation by its system prompt plus its first user
* message; hashing both keeps one conversation on one account while different
* conversations spread across the pool, which is what makes pooled use look
* like a single account to the upstream's own conversation memory.
*/
function stickyKeyOf(bodyJson) {
	let parsed;
	try {
		parsed = JSON.parse(bodyJson);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const messages = parsed["messages"];
	if (!Array.isArray(messages)) return void 0;
	let system = "";
	let firstUser = "";
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const record = message;
		const role = typeof record["role"] === "string" ? record["role"] : "";
		const content = record["content"];
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => typeof part === "object" && part !== null && typeof part["text"] === "string" ? [part["text"]] : []).join("") : "";
		if (text === "") continue;
		if ((role === "system" || role === "developer") && system === "") {
			system = text;
			continue;
		}
		if (role === "user") {
			firstUser = text;
			break;
		}
	}
	if (system === "" && firstUser === "") return void 0;
	return `d-${createHash("sha256").update(`${system}\u0000${firstUser}`).digest("hex").slice(0, 32)}`;
}
/** The local 04:00 following `now`, the hard-credit cooldown deadline. */
function nextDay4Am(now) {
	const date = new Date(now);
	date.setHours(4, 0, 0, 0);
	if (date.getTime() <= now) date.setDate(date.getDate() + 1);
	return date.getTime();
}
/**
* A weighted account pool over locally discovered WorkBuddy sign-ins.
*
* The pool owns no credentials: it decides *which* account id should serve a
* request, and the shim resolves that account's credential from the store.
* That split keeps token material out of the scheduling layer and makes the
* whole pick deterministic under an injected clock and RNG.
*/
var WorkBuddyAccountPool = class {
	list;
	now;
	random;
	entries = /* @__PURE__ */ new Map();
	sticky = /* @__PURE__ */ new Map();
	policy;
	totalInFlight = 0;
	seq = 0;
	gcTimer;
	constructor(options) {
		this.list = options.list;
		this.now = options.now ?? (() => Date.now());
		this.random = options.random ?? Math.random;
		this.policy = {
			...DEFAULT_WORKBUDDY_POOL_POLICY,
			...options.policy
		};
		for (const record of options.state ?? []) {
			const entry = this.blankEntry(record.accountId);
			entry.enabled = record.enabled;
			entry.weight = record.weight;
			entry.priority = record.priority;
			entry.cooldownUntil = record.cooldownUntil ?? 0;
			entry.cooldownKind = record.cooldownKind ?? (entry.cooldownUntil > 0 ? "soft" : "none");
			entry.softStreak = record.cooldownCount ?? 0;
			entry.breakerUntil = record.breakerUntil ?? 0;
			entry.degradedUntil = record.degradedUntil ?? 0;
			this.entries.set(record.accountId, entry);
		}
		this.startGc();
	}
	/** Replace the health policy; the next pick uses the new numbers. */
	setPolicy(policy) {
		this.policy = {
			...this.policy,
			...policy
		};
	}
	/** The policy in force. */
	currentPolicy() {
		return { ...this.policy };
	}
	blankEntry(accountId) {
		return {
			accountId,
			accountName: accountId,
			region: "cn",
			present: true,
			tokenExpiresAtMs: 0,
			enabled: true,
			weight: 10,
			priority: 100,
			cooldownUntil: 0,
			cooldownKind: "none",
			softStreak: 0,
			breakerUntil: 0,
			breakerFails: 0,
			breakerTrips: 0,
			degradedUntil: 0,
			consecutiveFails: 0,
			inFlight: 0,
			successes: 0,
			failures: 0,
			usedSeq: 0,
			lastUsedAt: 0,
			lastSuccessAt: 0,
			lastErrorAt: 0,
			lastError: "",
			credits: void 0,
			creditsExpiring: 0,
			creditsCapacity: 0,
			creditsAtMs: 0
		};
	}
	/**
	* Re-read the local accounts and merge them into the pool. Accounts that
	* vanished keep their entry (so their counters and the user's switch survive
	* a temporarily unreadable auth file) but are marked `present: false` and
	* become unpickable. Accounts that reappear are un-marked.
	*/
	async refresh() {
		const accounts = await this.list();
		const seen = /* @__PURE__ */ new Set();
		for (const account of accounts) {
			seen.add(account.id);
			const existing = this.entries.get(account.id);
			if (existing === void 0) {
				const entry = this.blankEntry(account.id);
				entry.accountName = account.accountName;
				entry.region = account.region;
				entry.tokenExpiresAtMs = account.tokenExpiresAtMs;
				this.entries.set(account.id, entry);
				continue;
			}
			existing.accountName = account.accountName;
			existing.region = account.region;
			existing.tokenExpiresAtMs = account.tokenExpiresAtMs;
			existing.present = true;
		}
		for (const entry of this.entries.values()) if (!seen.has(entry.accountId)) entry.present = false;
	}
	/** Drop every entry whose account no longer exists locally. */
	prune() {
		for (const [id, entry] of [...this.entries]) if (!entry.present) this.entries.delete(id);
		for (const [key, binding] of [...this.sticky]) if (!this.entries.has(binding.accountId)) this.sticky.delete(key);
	}
	/** Every entry, in card order: by priority, then by account name. */
	snapshot() {
		const now = this.now();
		return [...this.entries.values()].sort((left, right) => left.priority - right.priority || left.accountName.localeCompare(right.accountName)).map((entry) => this.view(entry, now));
	}
	/** One entry's card view, or undefined when the account is unknown. */
	entryView(accountId) {
		const entry = this.entries.get(accountId);
		return entry === void 0 ? void 0 : this.view(entry, this.now());
	}
	view(entry, now) {
		return {
			accountId: entry.accountId,
			accountName: entry.accountName,
			region: entry.region,
			enabled: entry.enabled,
			weight: entry.weight,
			priority: entry.priority,
			state: this.stateOf(entry, now),
			...entry.cooldownUntil > now ? { cooldownUntil: entry.cooldownUntil } : {},
			...entry.cooldownKind === "none" || entry.cooldownUntil <= now ? {} : { cooldownKind: entry.cooldownKind },
			...entry.breakerUntil > now ? { breakerUntil: entry.breakerUntil } : {},
			...entry.degradedUntil > now ? { degradedUntil: entry.degradedUntil } : {},
			inFlight: entry.inFlight,
			successes: entry.successes,
			failures: entry.failures,
			consecutiveFailures: entry.consecutiveFails + entry.breakerFails,
			cooldownCount: entry.softStreak + entry.breakerTrips,
			...entry.lastUsedAt === 0 ? {} : { lastUsedAt: entry.lastUsedAt },
			...entry.lastSuccessAt === 0 ? {} : { lastSuccessAt: entry.lastSuccessAt },
			...entry.lastErrorAt === 0 ? {} : { lastErrorAt: entry.lastErrorAt },
			...entry.lastError === "" ? {} : { lastError: entry.lastError },
			...entry.credits === void 0 ? {} : { credits: entry.credits },
			...entry.creditsAtMs === 0 ? {} : { creditsAtMs: entry.creditsAtMs },
			...entry.creditsExpiring === 0 ? {} : { creditsExpiringSoon: entry.creditsExpiring },
			...entry.creditsCapacity === 0 ? {} : { creditsCapacity: entry.creditsCapacity },
			present: entry.present,
			tokenExpiresAtMs: entry.tokenExpiresAtMs
		};
	}
	stateOf(entry, now) {
		if (!entry.present) return "missing";
		if (!entry.enabled) return "disabled";
		if (entry.cooldownUntil > now) return "cooldown";
		if (entry.breakerUntil > now) return "degraded";
		if (entry.degradedUntil > now) return "degraded";
		return "ready";
	}
	/** The per-account concurrency ceiling for this account's region. */
	inFlightLimit(entry) {
		if (entry.region === "global" && this.policy.maxInFlightGlobalPerAccount > 0) return this.policy.maxInFlightGlobalPerAccount;
		return this.policy.maxInFlightPerAccount;
	}
	/** Whether the account is below its concurrency ceiling. */
	inFlightFull(entry) {
		const limit = this.inFlightLimit(entry);
		return limit > 0 && entry.inFlight >= limit;
	}
	/**
	* The four-dimension health gate: present, enabled, out of every cooldown,
	* and below the concurrency ceiling.
	*/
	healthy(entry, now) {
		if (!entry.present || !entry.enabled) return false;
		if (entry.cooldownUntil > now) return false;
		if (entry.breakerUntil > now) return false;
		if (entry.degradedUntil > now) return false;
		return !this.inFlightFull(entry);
	}
	/** The earliest still-running deadline of an entry, or 0 when it is clear. */
	expiryOf(entry, now) {
		const deadlines = [
			entry.cooldownUntil,
			entry.breakerUntil,
			entry.degradedUntil
		].filter((deadline) => deadline > now);
		return deadlines.length === 0 ? 0 : Math.min(...deadlines);
	}
	/** The sticky binding for a session key, when it is alive. */
	stickyBinding(key, now) {
		if (key === void 0 || this.policy.stickyTtlMs <= 0) return void 0;
		const binding = this.sticky.get(key);
		if (binding === void 0) return void 0;
		if (now - binding.at > this.policy.stickyTtlMs) {
			this.sticky.delete(key);
			return;
		}
		const entry = this.entries.get(binding.accountId);
		if (entry === void 0) {
			this.sticky.delete(key);
			return;
		}
		return entry;
	}
	/** Weight of one candidate, per the reference's three-factor formula. */
	weightOf(entry, maxCredits, now) {
		let weight = 1;
		if (this.policy.balanceAware && maxCredits > 0 && entry.credits !== void 0) weight += entry.credits / maxCredits * 10;
		if (this.policy.balanceAware && entry.credits !== void 0 && entry.credits > 0 && entry.creditsExpiring > 0) weight += Math.min(entry.creditsExpiring, entry.credits) / entry.credits * this.policy.expiringWeight;
		if (this.policy.balanceAware) {
			if (entry.lastUsedAt === 0) weight += this.policy.idleWeightMax;
			else {
				const idle = Math.min(Math.max((now - entry.lastUsedAt) / 36e5 * this.policy.idleWeightPerHour, 0), this.policy.idleWeightMax);
				weight += idle;
			}
		}
		return weight * Math.max(entry.weight, 1);
	}
	/**
	* Choose the account for one request and reserve its concurrency slot. The
	* caller MUST call {@link release} once the request settles.
	*
	* Decision order, mirroring workbuddy2api's picker:
	*
	* 1. a live session binding wins whenever its account is healthy — one
	*    conversation must not bounce between accounts mid-flight;
	* 2. otherwise filter to healthy accounts the caller has not already tried;
	* 3. when nothing is healthy, fall back to the cooling account whose deadline
	*    expires first (never a hard-credit cooldown): a cooldown is a local
	*    guess, so it is still better to try than to fail the request;
	* 4. rank by weight (credits ×10, expiring credits ×8, idle 0.5/h up to 5);
	* 5. take the top five and drop those used inside the anti-collision gap,
	*    falling back to the least-recently-used account in the FULL candidate
	*    set — never only the shortlist, which would starve tied accounts;
	* 6. draw one weighted-random from what remains.
	*/
	pick(options = {}) {
		const now = this.now();
		const excluded = options.exclude ?? /* @__PURE__ */ new Set();
		const all = [...this.entries.values()];
		if (all.length === 0) return {
			ok: false,
			reason: "no-accounts"
		};
		if (all.every((entry) => !entry.enabled)) return {
			ok: false,
			reason: "all-disabled"
		};
		const pickable = all.filter((entry) => entry.enabled && entry.present);
		if (pickable.length === 0) return {
			ok: false,
			reason: "pool-saturated"
		};
		const bound = this.stickyBinding(options.stickyKey, now);
		if (bound !== void 0 && this.healthy(bound, now) && !excluded.has(bound.accountId) && this.totalInFlight < this.policy.maxInFlightTotal) return {
			ok: true,
			entry: this.view(this.dispatch(bound, now), now),
			fallback: false
		};
		if (this.policy.maxInFlightTotal > 0 && this.totalInFlight >= this.policy.maxInFlightTotal) return {
			ok: false,
			reason: "pool-saturated"
		};
		const candidates = all.filter((entry) => !excluded.has(entry.accountId) && this.healthy(entry, now));
		if (candidates.length === 0) {
			const fallback = this.pickEarliestExpiry(pickable, excluded, now);
			if (fallback === void 0) return {
				ok: false,
				reason: this.missReason(all)
			};
			return {
				ok: true,
				entry: this.view(this.dispatch(fallback, now), now),
				fallback: true
			};
		}
		let maxCredits = 0;
		for (const entry of candidates) if (entry.credits !== void 0 && entry.credits > maxCredits) maxCredits = entry.credits;
		const ranked = candidates.map((entry) => ({
			entry,
			weight: this.weightOf(entry, maxCredits, now)
		})).sort((left, right) => right.weight - left.weight || left.entry.usedSeq - right.entry.usedSeq);
		const eligible = ranked.slice(0, 5).filter((candidate) => now - candidate.entry.lastUsedAt >= this.policy.minPickGapMs);
		const chosen = eligible.length > 0 ? this.pickWeighted(eligible.map((candidate) => candidate.entry), eligible.map((candidate) => candidate.weight)) : ranked.reduce((best, candidate) => candidate.entry.usedSeq < best.entry.usedSeq ? candidate : best).entry;
		return {
			ok: true,
			entry: this.view(this.dispatch(chosen, now), now),
			fallback: false
		};
	}
	/** Why nothing could be picked, in the most specific available terms. */
	missReason(all) {
		if (all.length === 0) return "no-accounts";
		if (all.every((entry) => !entry.enabled)) return "all-disabled";
		return "pool-saturated";
	}
	/**
	* The all-cooling fallback: the account whose earliest running deadline is
	* closest. Hard-credit cooldowns are excluded — the account is out of
	* credits, so retrying it only burns a request.
	*/
	pickEarliestExpiry(all, excluded, now) {
		let best;
		let bestExpiry = 0;
		for (const entry of all) {
			if (excluded.has(entry.accountId)) continue;
			if (!entry.present || !entry.enabled) continue;
			if (entry.cooldownKind === "hard" && entry.cooldownUntil > now) continue;
			if (this.inFlightFull(entry)) continue;
			const expiry = this.expiryOf(entry, now);
			if (expiry === 0) continue;
			if (best === void 0 || expiry < bestExpiry) {
				best = entry;
				bestExpiry = expiry;
			}
		}
		return best;
	}
	/** Fixed-point weighted draw over the candidates. */
	pickWeighted(candidates, weights) {
		if (candidates.length === 1) return candidates[0];
		const scale = 1e6;
		const fixed = weights.map((weight) => Math.max(Math.round(weight * scale), 1));
		const total = fixed.reduce((sum, value) => sum + value, 0);
		if (!(total > 0)) return candidates[Math.min(Math.floor(this.random() * candidates.length), candidates.length - 1)];
		let ticket = Math.floor(this.random() * total);
		for (let index = 0; index < candidates.length; index += 1) {
			ticket -= fixed[index];
			if (ticket < 0) return candidates[index];
		}
		return candidates[candidates.length - 1];
	}
	/** Reserve one concurrency slot on an entry and record the dispatch. */
	dispatch(entry, now) {
		entry.inFlight += 1;
		this.totalInFlight += 1;
		entry.lastUsedAt = now;
		this.seq += 1;
		entry.usedSeq = this.seq;
		return entry;
	}
	/**
	* Return a reserved slot. Safe to call once per successful {@link pick};
	* a double release would corrupt the ceilings, so the caller must pair them.
	*/
	release(accountId) {
		const entry = this.entries.get(accountId);
		if (entry === void 0) return;
		if (entry.inFlight > 0) entry.inFlight -= 1;
		if (this.totalInFlight > 0) this.totalInFlight -= 1;
	}
	/**
	* Record one dispatch outcome and apply the health transition.
	*
	* | outcome | transition |
	* |---|---|
	* | success | clear every counter and rolling-renew the sticky binding |
	* | `hard_credit` | hard cooldown until the next local 04:00 |
	* | `session_dead` | hard cooldown until the next local 04:00 (re-sign-in) |
	* | `soft_rate` | soft cooldown, base 600s doubling per streak, capped at 2h; an already-running soft cooldown is never extended |
	* | `not_found` | fixed 60s soft cooldown |
	* | `server` | breaker: opens at 3 consecutive failures, 30m doubling, capped at 6h |
	* | `transport` / `client` | degrade after 5 consecutive failures (10m) — an unknown failure is not the account's fault |
	*/
	report(accountId, outcome, stickyKey) {
		const entry = this.entries.get(accountId);
		if (entry === void 0) return;
		const now = this.now();
		if (outcome.ok) {
			entry.successes += 1;
			entry.consecutiveFails = 0;
			entry.breakerFails = 0;
			entry.breakerTrips = 0;
			entry.softStreak = 0;
			entry.degradedUntil = 0;
			entry.lastSuccessAt = now;
			entry.lastError = "";
			if (stickyKey !== void 0 && this.policy.stickyTtlMs > 0) this.sticky.set(stickyKey, {
				accountId,
				at: now
			});
			return;
		}
		entry.failures += 1;
		entry.lastErrorAt = now;
		if (outcome.message !== void 0 && outcome.message !== "") entry.lastError = outcome.message.slice(0, 240);
		switch (outcome.kind) {
			case "hard_credit":
				entry.cooldownKind = "hard";
				entry.cooldownUntil = nextDay4Am(now);
				return;
			case "session_dead":
				entry.cooldownKind = "hard";
				entry.cooldownUntil = nextDay4Am(now);
				entry.lastError = "会话已失效，请在 WorkBuddy 桌面端重新登录该账号";
				return;
			case "soft_rate": {
				if (entry.cooldownKind === "soft" && entry.cooldownUntil > now) return;
				const shift = Math.min(entry.softStreak, 16);
				const grown = this.policy.softRateCooldownMs * 2 ** shift;
				const capped = Math.min(grown, this.policy.softRateCooldownMaxMs);
				entry.cooldownKind = "soft";
				entry.cooldownUntil = now + capped;
				entry.softStreak += 1;
				return;
			}
			case "not_found":
				entry.cooldownKind = "soft";
				entry.cooldownUntil = now + this.policy.notFoundCooldownMs;
				return;
			case "server": {
				entry.breakerFails += 1;
				if (entry.breakerFails < this.policy.breakerThreshold) return;
				const grown = this.policy.breakerCooldownMs * 2 ** Math.min(entry.breakerTrips, 8);
				entry.breakerUntil = now + Math.min(grown, this.policy.breakerCooldownMaxMs);
				entry.breakerTrips += 1;
				entry.breakerFails = 0;
				return;
			}
			default:
				entry.consecutiveFails += 1;
				if (entry.consecutiveFails < this.policy.degradeThreshold) return;
				entry.consecutiveFails = 0;
				if (entry.degradedUntil > now) return;
				entry.degradedUntil = now + Math.min(this.policy.degradeCooldownMs, this.policy.degradeCooldownMaxMs);
		}
	}
	/** Cache the credits the card or the CLI read for one account. */
	setCredits(accountId, credits) {
		const entry = this.entries.get(accountId);
		if (entry === void 0) return;
		entry.credits = credits.total;
		entry.creditsExpiring = credits.expiringSoon;
		if (credits.capacity !== void 0) entry.creditsCapacity = credits.capacity;
		entry.creditsAtMs = this.now();
	}
	/** Apply the card's per-account switches and weights. */
	configure(updates) {
		for (const update of updates) {
			const entry = this.entries.get(update.accountId);
			if (entry === void 0) continue;
			if (update.enabled !== void 0) entry.enabled = update.enabled;
			if (update.weight !== void 0) entry.weight = Math.min(Math.max(Math.round(update.weight), 1), 100);
			if (update.priority !== void 0) entry.priority = Math.round(update.priority);
		}
	}
	/** Forget one account's cooldown, breaker, and degrade marks. */
	reset(accountId) {
		const entry = this.entries.get(accountId);
		if (entry === void 0) return;
		entry.cooldownUntil = 0;
		entry.cooldownKind = "none";
		entry.softStreak = 0;
		entry.breakerUntil = 0;
		entry.breakerFails = 0;
		entry.breakerTrips = 0;
		entry.degradedUntil = 0;
		entry.consecutiveFails = 0;
	}
	/** The pool slice to persist into settings. */
	toPersisted() {
		const now = this.now();
		return [...this.entries.values()].sort((left, right) => left.priority - right.priority || left.accountId.localeCompare(right.accountId)).map((entry) => ({
			accountId: entry.accountId,
			enabled: entry.enabled,
			weight: entry.weight,
			priority: entry.priority,
			...entry.cooldownUntil > now ? {
				cooldownUntil: entry.cooldownUntil,
				cooldownKind: entry.cooldownKind === "none" ? "soft" : entry.cooldownKind
			} : {},
			...entry.softStreak === 0 ? {} : { cooldownCount: entry.softStreak },
			...entry.breakerUntil > now ? { breakerUntil: entry.breakerUntil } : {},
			...entry.degradedUntil > now ? { degradedUntil: entry.degradedUntil } : {}
		}));
	}
	/** Live sticky-binding count, for diagnostics. */
	stickySize() {
		return this.sticky.size;
	}
	/** Stop the sticky GC timer; called when the plugin is disposed. */
	dispose() {
		if (this.gcTimer !== void 0) clearInterval(this.gcTimer);
		this.gcTimer = void 0;
		this.sticky.clear();
	}
	startGc() {
		if (this.policy.stickyGcIntervalMs <= 0) return;
		this.gcTimer = setInterval(() => {
			const now = this.now();
			for (const [key, binding] of [...this.sticky]) if (now - binding.at > this.policy.stickyTtlMs) this.sticky.delete(key);
		}, this.policy.stickyGcIntervalMs);
		this.gcTimer.unref?.();
	}
};
//#endregion
//#region src/version.ts
/** The npm package version this build was produced from. */
const WORKBUDDY2API_VERSION = "0.4.2";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
* `workbuddy2api` provider is registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 心跳机制由其沿用自 corrinehu/dsh-workbuddy-connect（MIT）：浏览器端
*     无法写文件，其健康只能靠 console.error 上报，因此由宿主写心跳文件，
*     缺失即代表宿主从未启动；崩溃后的陈旧心跳通过 PID 存活检查识别。
* 改动：文件名与包名改成本插件；额外记录账号池规模，便于 `status` 直接
*   报出池子大小。
*
* @module dsh-workbuddy2api/host-heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const WORKBUDDY2API_HOST_HEARTBEAT_FILENAME = ".workbuddy2api-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** The package name recorded in the heartbeat, checked by the reader. */
const PACKAGE_NAME = "dsh-workbuddy2api";
/** Absolute path of the host heartbeat file. */
function workbuddyHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDY2API_HOST_HEARTBEAT_FILENAME);
}
/**
* Process start time in epoch milliseconds; undefined when unavailable.
*
* POSIX reads `ps -o lstart=`; Windows has no such command, so the creation
* time is taken from PowerShell's `Get-Process` StartTime, emitted as UTC ISO
* 8601 so `Date.parse` understands it without locale assumptions.
*/
function processStartTimeMs(pid) {
	try {
		const output = process.platform === "win32" ? execFileSync("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`
		], { encoding: "utf8" }) : execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], { encoding: "utf8" });
		const parsed = Date.parse(output.trim());
		return Number.isFinite(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* Whether the recorded host process still matches the heartbeat's PID.
*
* A PID can be reused after a crash, so the recorded start time is compared
* against the live process: a different start time means a different process.
*/
function isHeartbeatProcessAlive(heartbeat) {
	if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false;
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startedAt = processStartTimeMs(heartbeat.pid);
	if (startedAt === void 0) return true;
	return Math.abs(startedAt - heartbeat.registeredAt) < 6e4;
}
/** Read the heartbeat; absent or unparsable files report undefined. */
async function readHostHeartbeat() {
	try {
		const parsed = JSON.parse(await readFile(workbuddyHostHeartbeatPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const document = parsed;
		if (document["version"] !== HEARTBEAT_FORMAT_VERSION) return void 0;
		if (document["package"] !== PACKAGE_NAME) return void 0;
		const pid = document["pid"];
		const registeredAt = document["registeredAt"];
		if (typeof pid !== "number" || typeof registeredAt !== "number") return void 0;
		return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: PACKAGE_NAME,
			pluginVersion: typeof document["pluginVersion"] === "string" ? document["pluginVersion"] : WORKBUDDY2API_VERSION,
			registeredAt,
			pid,
			...typeof document["accounts"] === "number" ? { accounts: document["accounts"] } : {}
		};
	} catch {
		return;
	}
}
/** Write the heartbeat for the current process. */
async function writeHostHeartbeat(accounts) {
	const heartbeat = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: PACKAGE_NAME,
		pluginVersion: WORKBUDDY2API_VERSION,
		registeredAt: Date.now(),
		pid: process.pid,
		...accounts === void 0 ? {} : { accounts }
	};
	await writeFile(workbuddyHostHeartbeatPath(), `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 384 });
}
/** Remove the heartbeat; called when the plugin is disposed. */
async function clearHostHeartbeat() {
	await rm(workbuddyHostHeartbeatPath(), { force: true });
}
//#endregion
export { WorkBuddyUpstreamClient as A, defaultDesktopAuthDirs as C, parseWorkBuddyAuth as D, isFresher as E, parseUpstreamModel as F, parseUpstreamTask as I, prepareChatBody as L, isNightWindow as M, parseCreditMultiplier as N, workbuddyAccountId as O, parseReasoning as P, regionOf as R, defaultDesktopAuthCandidates as S, expiryToMs as T, deriveCatalog as _, readHostHeartbeat as a, WorkBuddyCredentialStore as b, WORKBUDDY2API_VERSION as c, nextDay4Am as d, stickyKeyOf as f, applyContextBudgets as g, WorkBuddyCatalog as h, processStartTimeMs as i, classifyUpstreamError as j, workbuddyOwnAuthPath as k, DEFAULT_WORKBUDDY_POOL_POLICY as l, FALLBACK_WORKBUDDY_MODELS_GLOBAL as m, clearHostHeartbeat as n, workbuddyHostHeartbeatPath as o, FALLBACK_WORKBUDDY_MODELS as p, isHeartbeatProcessAlive as r, writeHostHeartbeat as s, WORKBUDDY2API_HOST_HEARTBEAT_FILENAME as t, WorkBuddyAccountPool as u, fallbackModelsFor as v, defaultDesktopAuthPath as w, authFileName as x, WORKBUDDY_AUTH_FILE_ENV as y, selectCliModels as z };
