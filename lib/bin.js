#!/usr/bin/env node
import { A as WorkBuddyUpstreamClient, C as defaultDesktopAuthDirs, S as defaultDesktopAuthCandidates, a as readHostHeartbeat, b as WorkBuddyCredentialStore, c as WORKBUDDY2API_VERSION, l as DEFAULT_WORKBUDDY_POOL_POLICY, o as workbuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, u as WorkBuddyAccountPool, v as fallbackModelsFor, y as WORKBUDDY_AUTH_FILE_ENV } from "./host-heartbeat-BwvAd8aB.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/**
* Standalone status/diagnostics CLI for the dsh-workbuddy2api bundle.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 子命令（`doctor` / `status` / `logout`）、`--json` 输出、
*     `safeMessage` 脱敏、schemaVersion 字段、以及「宿主心跳 + 桌面端凭据
*     文件 + 登录态」三项联合诊断的结构，均由该项目沿用自
*     corrinehu/dsh-workbuddy-connect（MIT）。
* 改动：诊断对象按区域分开报告 —— 两个区域是两个独立账号池，
*   `status` / `pool` 分别列出每个池的账号、健康、余额；
*   `logout` 清除两个区域的全部插件自有凭据副本。
*
* @module dsh-workbuddy2api/bin
*/
const JSON_SCHEMA_VERSION = 1;
/** Both regions, in reporting order. */
const REGIONS = ["cn", "global"];
/** Region labels for human output. */
const REGION_LABELS = {
	cn: "CN (domestic)",
	global: "Global"
};
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy2api <doctor|status|pool|logout> [--json]",
		"",
		"  doctor   secret-free sign-in, credential-path, and host diagnostics",
		"  status   every pooled account per region: health, cooldown, and credit",
		"  pool     each region's live pool snapshot (weights, in-flight, failures)",
		"  logout   remove every plugin-owned credential copy (the desktop app keeps its sign-in)",
		"  --json   emit one secret-free JSON document (doctor/status/pool only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** A region-scoped store over the real machine's credentials. */
function makeStore(region, client) {
	return new WorkBuddyCredentialStore({
		region,
		refresh: (credential) => client.refreshToken(credential)
	});
}
async function doctor(jsonOutput) {
	const client = new WorkBuddyUpstreamClient();
	const anyStore = new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
	const desktopPresent = await anyStore.desktopFilePresent();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const regionLists = await Promise.all(REGIONS.map(async (region) => {
		try {
			return {
				region,
				accounts: await makeStore(region, client).accounts(),
				error: void 0
			};
		} catch (error) {
			return {
				region,
				accounts: [],
				error: safeMessage(error)
			};
		}
	}));
	const totalAccounts = regionLists.reduce((sum, entry) => sum + entry.accounts.length, 0);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy2api",
		version: WORKBUDDY2API_VERSION,
		node: process.version,
		desktopAuthFile: {
			path: anyStore.desktopAuthPath() ?? "(no platform default; set WORKBUDDY_AUTH_FILE)",
			dir: defaultDesktopAuthDirs()[0] ?? "(no platform default)",
			candidates: defaultDesktopAuthCandidates(),
			present: desktopPresent
		},
		providerRoutes: {
			cn: "workbuddy2api",
			global: "workbuddy2api-global"
		},
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			...heartbeat?.accounts === void 0 ? {} : { accounts: heartbeat.accounts },
			processAlive: hostAlive
		},
		regions: Object.fromEntries(regionLists.map(({ region, accounts, error }) => [region, {
			accounts: accounts.map((account) => ({
				id: account.id,
				accountName: account.accountName,
				domain: account.domain === "" ? void 0 : account.domain,
				source: account.source,
				tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString()
			})),
			...error === void 0 ? {} : { error },
			fallbackModels: fallbackModelsFor(region).length
		}])),
		poolPolicy: DEFAULT_WORKBUDDY_POOL_POLICY,
		hints: [
			...totalAccounts > 0 ? [] : ["Sign in once in the WorkBuddy desktop app (either region), then run status again."],
			...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and providers are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`WorkBuddy2API ${WORKBUDDY2API_VERSION} on ${process.version}`,
		`Desktop auth file: ${desktopPresent ? "present" : "missing"} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		...regionLists.flatMap(({ region, accounts, error }) => [
			`${REGION_LABELS[region]} — provider ${region === "global" ? "workbuddy2api-global" : "workbuddy2api"}: ${accounts.length} account(s)`,
			...error === void 0 ? [] : [`  scan error: ${error}`],
			...accounts.map((account) => `  - ${account.accountName} (${account.id})${account.domain === "" ? "" : ` · ${account.domain}`} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`)
		]),
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return totalAccounts > 0 && desktopPresent ? 0 : 1;
}
/** One region's pool plus its per-account credit probe. */
async function regionStatus(region, client) {
	const store = makeStore(region, client);
	const pool = new WorkBuddyAccountPool({ list: () => store.accounts() });
	await pool.refresh();
	const entries = pool.snapshot();
	const credits = await Promise.all(entries.map(async (entry) => {
		if (!entry.present) return {
			accountId: entry.accountId,
			error: "credential file missing"
		};
		try {
			const credential = await store.resolve(entry.accountId);
			const answer = await client.fetchCredits(credential);
			pool.setCredits(entry.accountId, {
				total: answer.total,
				expiringSoon: answer.expiringSoon
			});
			return {
				accountId: entry.accountId,
				total: answer.total,
				expiringSoon: answer.expiringSoon
			};
		} catch (error) {
			return {
				accountId: entry.accountId,
				error: safeMessage(error)
			};
		}
	}));
	pool.dispose();
	return {
		region,
		provider: region === "global" ? "workbuddy2api-global" : "workbuddy2api",
		entries: entries.map((entry, index) => ({
			...entry,
			...credits[index]
		})),
		credits
	};
}
async function status(jsonOutput) {
	const client = new WorkBuddyUpstreamClient();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	const fragments = await Promise.all(REGIONS.map((region) => regionStatus(region, client)));
	const signedIn = fragments.some((fragment) => fragment.entries.some((entry) => entry.present && entry.enabled));
	if (jsonOutput) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy2api",
		version: WORKBUDDY2API_VERSION,
		regions: Object.fromEntries(fragments.map((fragment) => [fragment.region, fragment])),
		hostBundle: hostState
	});
	else process.stdout.write([
		...fragments.flatMap((fragment) => [
			`${REGION_LABELS[fragment.region]} — provider ${fragment.provider}: ${fragment.entries.length} account(s)`,
			...fragment.entries.flatMap((entry) => [
				`  ${entry.accountName} (${entry.accountId}) — ${entry.state}${entry.enabled ? "" : " / disabled"}`,
				...entry.cooldownUntil === void 0 ? [] : [`    cooldown(${entry.cooldownKind ?? "soft"}) until ${new Date(entry.cooldownUntil).toISOString()}`],
				...entry.breakerUntil === void 0 ? [] : [`    breaker until ${new Date(entry.breakerUntil).toISOString()}`],
				...entry.degradedUntil === void 0 ? [] : [`    degraded until ${new Date(entry.degradedUntil).toISOString()}`],
				`    ok ${entry.successes} / failed ${entry.failures} / in-flight ${entry.inFlight}`
			]),
			...fragment.credits.flatMap((probe) => probe.error === void 0 ? [`  credit ${probe.accountId.slice(0, 8)}…: ${probe.total}${probe.expiringSoon === void 0 || probe.expiringSoon === 0 ? "" : ` (expiring soon ${probe.expiringSoon})`}`] : [`  credit ${probe.accountId.slice(0, 8)}…: unavailable (${probe.error})`])
		]),
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host providers are unaffected.",
		""
	].join("\n"));
	return signedIn ? 0 : 1;
}
/** Print each region's live pool snapshot without touching the network. */
async function poolStatus(jsonOutput) {
	const client = new WorkBuddyUpstreamClient();
	const fragments = await Promise.all(REGIONS.map(async (region) => {
		const store = makeStore(region, client);
		const pool = new WorkBuddyAccountPool({ list: () => store.accounts() });
		await pool.refresh();
		const snapshot = {
			region,
			entries: pool.snapshot(),
			policy: pool.currentPolicy(),
			sticky: pool.stickySize()
		};
		pool.dispose();
		return snapshot;
	}));
	if (jsonOutput) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy2api",
		version: WORKBUDDY2API_VERSION,
		regions: Object.fromEntries(fragments.map((fragment) => [fragment.region, fragment]))
	});
	else process.stdout.write([...fragments.flatMap((fragment) => [
		`${REGION_LABELS[fragment.region]} — provider ${fragment.region === "global" ? "workbuddy2api-global" : "workbuddy2api"}`,
		...fragment.entries.length === 0 ? ["  (no accounts in this region)"] : [],
		...fragment.entries.flatMap((entry) => [
			`  ${entry.accountName} (${entry.accountId}) — ${entry.state}`,
			`    weight ${entry.weight} · priority ${entry.priority} · in-flight ${entry.inFlight}`,
			`    ok ${entry.successes} / failed ${entry.failures} / consecutive ${entry.consecutiveFailures} / cooldowns ${entry.cooldownCount}`,
			...entry.credits === void 0 ? [] : [`    credits ${entry.credits}`]
		]),
		`  policy: in-flight ${fragment.policy.maxInFlightPerAccount}/account (global cap ${fragment.policy.maxInFlightGlobalPerAccount}), total ${fragment.policy.maxInFlightTotal}`,
		`  sticky bindings: ${fragment.sticky} (ttl ${fragment.policy.stickyTtlMs}ms)`
	]), ""].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"logout",
		"pool",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy2api: expected doctor, logout, pool, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	if (flags.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-workbuddy2api: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput);
			case "status": return await status(jsonOutput);
			case "pool": return await poolStatus(jsonOutput);
			case "logout": {
				const client = new WorkBuddyUpstreamClient();
				for (const region of REGIONS) await makeStore(region, client).logout();
				process.stdout.write("WorkBuddy2API: removed the plugin-owned per-account credential copies for both regions; the desktop app's sign-ins are untouched\n");
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy2api: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
