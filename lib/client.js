window.__ModuleLoader__.load({
	id: "dsh-workbuddy2api",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/**
		* Node-free constants and types shared by the Host and browser halves.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — 「同源只读路由 + 一份与浏览器共享的 node-free 类型定义」的 host↔client
		*     桥梁形态来自该项目（其源自 dsh-connect-trae，并注明沿用
		*     corrinehu/dsh-workbuddy-connect 的 status-route 模式）。
		* 改动：路由路径改用本插件 id；文档结构从「一个账号 + 一份目录」改成
		*   「账号池 + 每账号健康 + 一份合并目录」，并新增池操作路由
		*   （启用/停用/重置/权重）与积分刷新路由。
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
		/** Plugin-owned pool control endpoint (enable / disable / reset / weight). */
		const WORKBUDDY2API_POOL_ACTION_PATH = "/plugins/dsh-workbuddy2api/pool";
		/** Query parameter naming the account a card request addresses. */
		const WORKBUDDY2API_ACCOUNT_PARAM = "accountId";
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
		/** Data-URI form of the card icon. */
		const WORKBUDDY2API_PLUGIN_ICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#1f6feb"/>
  <circle cx="9" cy="8" r="2.6" fill="#ffffff" opacity="0.95"/>
  <circle cx="9" cy="16" r="2.6" fill="#ffffff" opacity="0.75"/>
  <circle cx="9" cy="24" r="2.6" fill="#ffffff" opacity="0.55"/>
  <path d="M11.6 8 H17 a3 3 0 0 1 3 3 V14" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <path d="M11.6 16 H18.4" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <path d="M11.6 24 H17 a3 3 0 0 0 3 -3 V18" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <rect x="20.5" y="13.5" width="6" height="5" rx="1.6" fill="#ffffff"/>
</svg>`)}`;
		//#endregion
		//#region src/client/styles.ts
		/**
		* Client styles for the WorkBuddy account-pool card.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — 整套 `dsm-*` 卡片样式系统（卡片外壳、按钮原语、`--dsw-alias-*`
		*     主题变量与十六进制回退值）沿用自该项目（其复制自
		*     dsh-connect-trae / dsh-subagent-default-model 的 SETTINGS_CSS），
		*     沿用目的是让同一家族的插件共享同一套外部表现语言。
		* 改动：类名前缀改为 `dsm-wb2api-*`；新增账号池行（健康徽标、权重输入、
		*   冷却/熔断提示）与池策略表单的样式。
		*
		* @module dsh-workbuddy2api/client/styles
		*/
		const WORKBUDDY2API_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;display:inline-flex;transition:transform .16s}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-wb2api-root{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px}
.dsm-wb2api-section{display:flex;flex-direction:column;gap:10px}
.dsm-wb2api-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-wb2api-section-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-wb2api-section-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-wb2api-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-wb2api-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-wb2api-account-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-wb2api-account{display:flex;flex-direction:column;gap:7px;padding:11px 12px;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-wb2api-account+.dsm-wb2api-account{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-wb2api-account-head{display:flex;align-items:center;gap:10px;min-width:0}
.dsm-wb2api-account-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-wb2api-account-region{flex:none;padding:1px 7px;border-radius:999px;font-size:11px;line-height:15px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-wb2api-badge{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;border:1px solid transparent}
.dsm-wb2api-badge-ready{color:#3f8d60;background:rgba(63,141,96,.14);border-color:rgba(63,141,96,.4)}
.dsm-wb2api-badge-cooldown{color:#c98a2b;background:rgba(201,138,43,.14);border-color:rgba(201,138,43,.4)}
.dsm-wb2api-badge-degraded{color:#b3712b;background:rgba(179,113,43,.12);border-color:rgba(179,113,43,.36)}
.dsm-wb2api-badge-disabled,.dsm-wb2api-badge-missing{color:var(--dsw-alias-label-tertiary,#999);background:rgba(174,179,187,.1);border-color:rgba(174,179,187,.28)}
.dsm-wb2api-account-spacer{flex:1;min-width:0}
.dsm-wb2api-account-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-account-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dsm-wb2api-switch{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-switch input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-weight{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-weight input{width:56px;font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-account-hint{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-wb2api-policy{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 14px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-wb2api-policy-field{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-wb2api-policy-field input[type=number]{width:74px;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-policy-field input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-policy-note{grid-column:1/-1;margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-wb2api-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-wb2api-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-wb2api-model-disabled{opacity:.55}
.dsm-wb2api-model+.dsm-wb2api-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-wb2api-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-wb2api-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1}
.dsm-wb2api-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-wb2api-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-wb2api-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
.dsm-wb2api-model-details{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-wb2api-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-context-budget{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-context-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-wb2api-context-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-wb2api-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-wb2api-save-error{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:16px;text-align:right}
.dsm-wb2api-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
@media (max-width:760px){.dsm-wb2api-policy{grid-template-columns:1fr}}
`;
		//#endregion
		//#region src/client/WorkBuddyPoolCard.tsx
		/**
		* WorkBuddy account-pool card contributed to Harness Plugin configuration.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — 卡片的整体结构（折叠外壳 / 账号状态行 / 积分区 / 模型表 / 操作按钮行）、
		*     模块加载时注入一次 `<style>` 的写法、草稿态与 dirty 标记的保存流程、
		*     60 秒轮询与 AbortController 清理、`IconChevronDownOutline14` 的使用，
		*     均来自该项目（其 TraeUsageCard 又源自 dsh-connect-trae /
		*     dsh-subagent-default-model）。
		* 改动：
		*   1. 卡片主体从「一个账号 + 一份目录」改为「账号池」：每个账号一行，
		*      显示健康徽标、在途/成功/失败计数、冷却截止、最近错误、积分，
		*      并提供启用开关、权重输入、恢复按钮；
		*   2. 新增池策略表单（在途上限、熔断、降权、限流冷却、粘性 TTL、余额排序），
		*      与账号开关一起构成这份卡片的草稿与保存内容；
		*   3. 积分不再每次轮询都打上游：轮询读池内缓存，显式点「刷新积分」才查询，
		*      因为多账号下每次轮询都要打 N 个上游计费接口。
		*
		* @module dsh-workbuddy2api/client/WorkBuddyPoolCard
		*/
		const POLL_INTERVAL_MS = 6e4;
		/** Inject or refresh the shared card CSS for the current client bundle. */
		if (typeof document !== "undefined") {
			const cssId = "dsh-workbuddy2api/client.css";
			const existing = document.querySelector(`style[data-plugin-css="${cssId}"]`);
			if (existing !== null) existing.textContent = WORKBUDDY2API_CARD_CSS;
			else {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-workbuddy2api";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = WORKBUDDY2API_CARD_CSS;
				document.head.appendChild(styleTag);
			}
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0, {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2
			}).format(value);
		}
		function formatDateTime(value) {
			return new Intl.DateTimeFormat(void 0, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			}).format(new Date(value));
		}
		function formatCapacity(value, unknown) {
			if (value === void 0) return unknown;
			if (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6}M`;
			if (value >= 1e3 && value % 1e3 === 0) return `${value / 1e3}K`;
			return formatNumber(value);
		}
		/** The read-only fallback document used before the first fetch resolves. */
		const EMPTY_USAGE = {
			status: "empty",
			accounts: [],
			pool: []
		};
		/** Render the account pool, its credits, its policy, and the model selection. */
		function WorkBuddyPoolCard({ t, settingsScope }) {
			if (t === void 0) throw new Error("WorkBuddy pool card requires its translation function");
			const [open, setOpen] = (0, react.useState)(false);
			const [usage, setUsage] = (0, react.useState)(EMPTY_USAGE);
			const [busy, setBusy] = (0, react.useState)(false);
			const [settingsRevision, setSettingsRevision] = (0, react.useState)(0);
			const [poolDraft, setPoolDraft] = (0, react.useState)(void 0);
			const [modelDraft, setModelDraft] = (0, react.useState)(void 0);
			const [saving, setSaving] = (0, react.useState)(false);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [refreshingCredits, setRefreshingCredits] = (0, react.useState)(false);
			const [checkingIn, setCheckingIn] = (0, react.useState)(void 0);
			const [actionError, setActionError] = (0, react.useState)(void 0);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => settingsScope?.subscribe(() => {
				setSettingsRevision((value) => value + 1);
			}), [settingsScope]);
			const refreshUsage = (0, react.useCallback)(async (signal) => {
				try {
					const response = await fetch(WORKBUDDY2API_USAGE_PATH, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const document = value;
					if (mounted.current && signal?.aborted !== true) setUsage(document);
					return document;
				} catch (error) {
					if (mounted.current && signal?.aborted !== true) setUsage({
						status: "error",
						message: error instanceof Error ? error.message : t("row.requestFailed")
					});
					return;
				}
			}, [t]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refreshUsage(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refreshUsage]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refreshUsage(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [open, refreshUsage]);
			const writable = settingsScope?.getSnapshot().writable === true;
			const savedPoolState = usage.status === "ready" ? usage.poolState : [];
			const savedPolicy = usage.status === "ready" ? usage.policy : void 0;
			const entries = usage.status === "ready" || usage.status === "empty" ? usage.pool : [];
			const activeAccounts = poolDraft?.accounts ?? new Map(entries.map((entry) => [entry.accountId, {
				enabled: entry.enabled,
				weight: entry.weight
			}]));
			const activePolicy = poolDraft?.policy ?? savedPolicy;
			const poolDirty = poolDraft !== void 0;
			const modelsDirty = modelDraft !== void 0;
			const editPool = (edit) => {
				setPoolDraft((previous) => edit(previous ?? {
					accounts: new Map(entries.map((entry) => [entry.accountId, {
						enabled: entry.enabled,
						weight: entry.weight
					}])),
					policy: savedPolicy ?? FALLBACK_POLICY
				}));
			};
			const toggleAccount = (accountId) => {
				editPool((current) => {
					const accounts = new Map(current.accounts);
					const existing = accounts.get(accountId) ?? {
						enabled: true,
						weight: 10
					};
					accounts.set(accountId, {
						...existing,
						enabled: !existing.enabled
					});
					return {
						...current,
						accounts
					};
				});
			};
			const setAccountWeight = (accountId, weight) => {
				editPool((current) => {
					const accounts = new Map(current.accounts);
					const existing = accounts.get(accountId) ?? {
						enabled: true,
						weight: 10
					};
					accounts.set(accountId, {
						...existing,
						weight
					});
					return {
						...current,
						accounts
					};
				});
			};
			const setPolicyField = (field, value) => {
				editPool((current) => ({
					...current,
					policy: {
						...current.policy,
						[field]: value
					}
				}));
			};
			const discardPool = () => {
				setPoolDraft(void 0);
			};
			const discardModels = () => {
				setModelDraft(void 0);
			};
			const saveAll = async () => {
				if (settingsScope === void 0) return;
				setSaving(true);
				setSaveError(void 0);
				try {
					if (poolDraft !== void 0) {
						const records = savedPoolState.map((record) => {
							const edited = poolDraft.accounts.get(record.accountId);
							return edited === void 0 ? record : {
								...record,
								enabled: edited.enabled,
								weight: Math.min(Math.max(Math.round(edited.weight), 1), 100)
							};
						});
						for (const [accountId, edited] of poolDraft.accounts) {
							if (records.some((record) => record.accountId === accountId)) continue;
							records.push({
								accountId,
								enabled: edited.enabled,
								weight: Math.min(Math.max(Math.round(edited.weight), 1), 100),
								priority: 100
							});
						}
						await settingsScope.set("poolState", records);
						await settingsScope.set("pool", { ...poolDraft.policy });
					}
					if (modelDraft !== void 0) {
						await settingsScope.set("lastCatalog", modelDraft.models.map(toPersistedWorkBuddyModel));
						await settingsScope.set("enabledModelIds", [...modelDraft.enabledIds]);
						await settingsScope.set("imageModelIds", [...modelDraft.imageIds]);
						await settingsScope.set("contextBudgets", modelDraft.contextBudgets);
					}
					setPoolDraft(void 0);
					setModelDraft(void 0);
					await refreshUsage();
				} catch (error) {
					if (mounted.current) setSaveError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setSaving(false);
				}
			};
			const rescanAccounts = async () => {
				setBusy(true);
				setActionError(void 0);
				try {
					const response = await fetch(WORKBUDDY2API_ACCOUNTS_REFRESH_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refreshUsage();
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const refreshCredits = async () => {
				setRefreshingCredits(true);
				setActionError(void 0);
				try {
					const response = await fetch(WORKBUDDY2API_CREDITS_REFRESH_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refreshUsage();
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setRefreshingCredits(false);
				}
			};
			const resetAccount = async (accountId) => {
				setActionError(void 0);
				try {
					const response = await fetch(WORKBUDDY2API_POOL_ACTION_PATH, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({
							action: "reset",
							accountId
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refreshUsage();
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				}
			};
			const claimCheckin = async (accountId) => {
				setCheckingIn(accountId);
				setActionError(void 0);
				try {
					const response = await fetch(`${WORKBUDDY2API_CHECKIN_PATH}?${WORKBUDDY2API_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					await refreshUsage();
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setCheckingIn(void 0);
				}
			};
			const refreshModels = async () => {
				setBusy(true);
				setActionError(void 0);
				try {
					const response = await fetch(WORKBUDDY2API_MODELS_REFRESH_PATH, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json();
					if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error ?? `HTTP ${response.status}`);
					const fresh = body.models;
					const freshIds = new Set(fresh.map((model) => model.id));
					const source = modelDraft ?? (usage.status === "ready" ? {
						models: usage.models,
						enabledIds: new Set(usage.enabledModelIds),
						imageIds: new Set(usage.imageModelIds),
						contextBudgets: savedContextBudgets()
					} : void 0);
					const stillBudgets = {};
					for (const id of freshIds) {
						const budget = source?.contextBudgets[id];
						if (typeof budget === "number") stillBudgets[id] = budget;
					}
					setModelDraft({
						models: fresh,
						enabledIds: new Set([...source?.enabledIds ?? []].filter((id) => freshIds.has(id))),
						imageIds: new Set([...source?.imageIds ?? []].filter((id) => freshIds.has(id))),
						contextBudgets: stillBudgets
					});
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			/** The context budgets saved in settings, as the model draft needs them. */
			function savedContextBudgets() {
				const value = (settingsScope?.getSnapshot().value)?.contextBudgets;
				return typeof value === "object" && value !== null ? value : {};
			}
			const editModels = (edit) => {
				setModelDraft((previous) => edit(previous ?? {
					models: usage.status === "ready" ? [...usage.models] : [],
					enabledIds: new Set(usage.status === "ready" ? usage.enabledModelIds : []),
					imageIds: new Set(usage.status === "ready" ? usage.imageModelIds : []),
					contextBudgets: savedContextBudgets()
				}));
			};
			const toggleModel = (modelId) => {
				editModels((current) => {
					const enabledIds = new Set(current.enabledIds);
					if (!enabledIds.delete(modelId)) enabledIds.add(modelId);
					return {
						...current,
						enabledIds
					};
				});
			};
			const toggleImage = (modelId) => {
				editModels((current) => {
					const imageIds = new Set(current.imageIds);
					if (!imageIds.delete(modelId)) imageIds.add(modelId);
					return {
						...current,
						imageIds
					};
				});
			};
			const setContextBudget = (modelId, budget) => {
				editModels((current) => ({
					...current,
					contextBudgets: {
						...current.contextBudgets,
						[modelId]: budget
					}
				}));
			};
			const title = t("row.title");
			const statusLabel = usage.status === "ready" ? t("row.accountsTitle") : usage.status === "error" ? t("row.requestFailed") : t("row.empty");
			const visibleModels = modelDraft?.models ?? (usage.status === "ready" ? usage.models : []);
			const activeEnabledIds = modelDraft?.enabledIds ?? new Set(usage.status === "ready" ? usage.enabledModelIds : []);
			const activeImageIds = modelDraft?.imageIds ?? new Set(usage.status === "ready" ? usage.imageModelIds : []);
			const activeContextBudgets = modelDraft?.contextBudgets ?? savedContextBudgets();
			const creditsByAccount = new Map((usage.status === "ready" ? usage.credits : []).map((credit) => [credit.accountId, credit]));
			const dirty = poolDirty || modelsDirty;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-plugin-card-header",
					"aria-expanded": open,
					"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: "dsm-plugin-card-icon",
							src: WORKBUDDY2API_PLUGIN_ICON,
							alt: ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-plugin-card-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-title",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-description",
								children: t("row.desc")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`,
							children: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					hidden: !open,
					children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-wb2api-root",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-wb2api-section",
								"aria-label": t("row.accountsTitle"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-wb2api-section-head",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-wb2api-section-title",
										children: t("row.accountsTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-wb2api-section-sub",
										children: t("row.accountsHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-actions-buttons",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: busy || refreshingCredits,
											onClick: () => {
												refreshCredits();
											},
											children: refreshingCredits ? t("row.refreshingCredits") : t("row.refreshCredits")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: busy,
											onClick: () => {
												rescanAccounts();
											},
											children: busy ? t("row.accountsScanning") : t("row.accountsRescan")
										})]
									})]
								}), entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-wb2api-text",
									children: usage.status === "empty" ? usage.message ?? t("row.emptyHint") : statusLabel
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-wb2api-account-list",
									children: entries.map((entry) => {
										const edited = activeAccounts.get(entry.accountId);
										const enabled = edited?.enabled ?? entry.enabled;
										const weight = edited?.weight ?? entry.weight;
										const credit = creditsByAccount.get(entry.accountId);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-wb2api-account",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-wb2api-account-head",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "dsm-wb2api-account-name",
															children: entry.accountName
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "dsm-wb2api-account-region",
															children: entry.region === "global" ? "Global" : "CN"
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: `dsm-wb2api-badge dsm-wb2api-badge-${entry.state}`,
															children: t(stateKeyOf(entry.state))
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsm-wb2api-account-spacer" }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															className: "dsm-wb2api-switch",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "checkbox",
																checked: enabled,
																disabled: !writable || saving,
																onChange: () => {
																	toggleAccount(entry.accountId);
																}
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountEnabled") })]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															className: "dsm-wb2api-weight",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountWeight") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "number",
																min: 1,
																max: 100,
																value: weight,
																disabled: !writable || saving,
																onChange: (event) => {
																	const next = Number(event.currentTarget.value);
																	if (Number.isFinite(next)) setAccountWeight(entry.accountId, next);
																}
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "dsm-btn dsm-btn-outline",
															onClick: () => {
																resetAccount(entry.accountId);
															},
															children: t("row.accountReset")
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-wb2api-account-meta",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountInFlight", { count: entry.inFlight }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountSuccess", { ok: entry.successes }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountFailure", { failed: entry.failures }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountExpires", { at: formatDateTime(entry.tokenExpiresAtMs) }) }),
														entry.cooldownUntil === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountCooldownUntil", { at: formatDateTime(entry.cooldownUntil) }) }),
														entry.breakerUntil === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountBreakerUntil", { at: formatDateTime(entry.breakerUntil) }) }),
														entry.degradedUntil === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.accountDegradedUntil", { at: formatDateTime(entry.degradedUntil) }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: credit?.credits === void 0 ? t("row.accountCreditsUnknown") : credit.credits.expiringSoon > 0 ? t("row.accountCreditsExpiring", {
															credits: formatNumber(credit.credits.total),
															soon: formatNumber(credit.credits.expiringSoon)
														}) : t("row.accountCredits", { credits: formatNumber(credit.credits.total) }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "dsm-btn dsm-btn-outline",
															disabled: checkingIn !== void 0,
															onClick: () => {
																claimCheckin(entry.accountId);
															},
															children: checkingIn === entry.accountId ? t("row.checkinClaiming") : t("row.checkinClaim")
														})
													]
												}),
												credit?.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-wb2api-account-hint",
													children: t("row.creditsError", { message: credit.creditsError })
												}),
												entry.lastError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-wb2api-account-hint",
													children: t("row.accountLastError", { message: entry.lastError })
												})
											]
										}, entry.accountId);
									})
								})]
							}),
							activePolicy === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-wb2api-section",
								"aria-label": t("row.policyTitle"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-wb2api-section-head",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-wb2api-section-title",
										children: t("row.policyTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-wb2api-section-sub",
										children: t("row.policyHint")
									})] })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-wb2api-policy",
									children: [policyFields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "dsm-wb2api-policy-field",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(field.label) }), field.kind === "boolean" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: activePolicy[field.key],
											disabled: !writable || saving,
											onChange: (event) => {
												setPolicyField(field.key, event.currentTarget.checked);
											}
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "number",
											min: 0,
											value: field.kind === "seconds" ? Math.round(activePolicy[field.key] / 1e3) : activePolicy[field.key],
											disabled: !writable || saving,
											onChange: (event) => {
												const next = Number(event.currentTarget.value);
												if (!Number.isFinite(next)) return;
												setPolicyField(field.key, field.kind === "seconds" ? next * 1e3 : next);
											}
										})]
									}, field.key)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-wb2api-policy-note",
										children: t("row.policyBalanceHint")
									})]
								})]
							}),
							usage.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-wb2api-models",
								"aria-label": t("row.modelsTitle"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-section-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: "dsm-wb2api-section-title",
											children: t("row.modelsTitle")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-wb2api-section-sub",
											children: t("row.modelsSummary", { count: activeEnabledIds.size })
										})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: busy,
											onClick: () => {
												refreshModels();
											},
											children: busy ? t("row.modelsRefreshing") : t("row.modelsRefresh")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-wb2api-model-list",
										children: visibleModels.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: `dsm-wb2api-model${activeEnabledIds.has(model.id) ? "" : " dsm-wb2api-model-disabled"}`,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsm-wb2api-model-head",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														className: "dsm-wb2api-model-enabled",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: activeEnabledIds.has(model.id),
															disabled: !writable || saving,
															onChange: () => {
																toggleModel(model.id);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "dsm-wb2api-model-name",
															children: [model.name, model.creditMultiplier === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: "dsm-wb2api-model-name-rate",
																children: [
																	"(",
																	model.creditMultiplier.toFixed(2),
																	"x)"
																]
															})]
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														className: "dsm-wb2api-model-image",
														title: t("row.modelImage"),
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: activeImageIds.has(model.id),
															disabled: !writable || saving,
															onChange: () => {
																toggleImage(model.id);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelImage") })]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
														className: "dsm-wb2api-context-budget",
														"aria-label": t("row.contextBudget"),
														children: [model.nativeContextWindow > 2e5 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "radio",
															name: `context-${model.id}`,
															checked: (activeContextBudgets[model.id] ?? 2e5) === 2e5,
															disabled: !writable || saving,
															onChange: () => {
																setContextBudget(model.id, 2e5);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "200K" })] }) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "radio",
															name: `context-${model.id}`,
															checked: model.nativeContextWindow <= 2e5 || activeContextBudgets[model.id] === model.nativeContextWindow,
															disabled: model.nativeContextWindow <= 2e5 || !writable || saving,
															onChange: () => {
																setContextBudget(model.id, model.nativeContextWindow);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatCapacity(model.nativeContextWindow, t("row.modelUnknown")) })] })]
													})
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dsm-wb2api-model-details",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-wb2api-model-meta",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelContext", { context: formatCapacity(model.nativeContextWindow, t("row.modelUnknown")) }) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelOutput", { output: formatCapacity(model.maxTokens, t("row.modelUnknown")) }) }),
														model.reasoning?.supportedEfforts === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelReasoning", { efforts: model.reasoning.supportedEfforts.join(" / ") }) })
													]
												})
											})]
										}, model.id))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-wb2api-model-capability-note",
										children: t("row.modelCapabilityPending")
									})
								]
							}) : null,
							usage.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-wb2api-error",
								children: usage.message
							}) : null,
							actionError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-wb2api-error",
								children: actionError
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-wb2api-actions",
								children: [saveError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-wb2api-save-error",
									children: t("row.saveError", { message: saveError })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-wb2api-actions-buttons",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: !dirty || saving,
										onClick: () => {
											discardPool();
											discardModels();
										},
										children: t("row.discard")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-primary",
										disabled: !dirty || saving || !writable,
										onClick: () => {
											saveAll();
										},
										children: saving ? t("row.saving") : t("row.save")
									})]
								})]
							})
						]
					}) : null
				})]
			});
		}
		/** Locale key for one pool state. */
		function stateKeyOf(state) {
			switch (state) {
				case "ready": return "row.stateReady";
				case "cooldown": return "row.stateCooldown";
				case "degraded": return "row.stateDegraded";
				case "missing": return "row.stateMissing";
				default: return "row.stateDisabled";
			}
		}
		/** Numeric policy fields the card edits; `seconds` fields are shown in seconds. */
		const policyFields = [
			{
				key: "maxInFlightPerAccount",
				label: "row.policyInFlight",
				kind: "count"
			},
			{
				key: "maxInFlightGlobalPerAccount",
				label: "row.policyInFlightGlobal",
				kind: "count"
			},
			{
				key: "maxInFlightTotal",
				label: "row.policyInFlightTotal",
				kind: "count"
			},
			{
				key: "breakerThreshold",
				label: "row.policyBreaker",
				kind: "count"
			},
			{
				key: "breakerCooldownMs",
				label: "row.policyBreakerCooldown",
				kind: "seconds"
			},
			{
				key: "breakerCooldownMaxMs",
				label: "row.policyBreakerMax",
				kind: "seconds"
			},
			{
				key: "degradeThreshold",
				label: "row.policyDegrade",
				kind: "count"
			},
			{
				key: "degradeCooldownMs",
				label: "row.policyDegradeCooldown",
				kind: "seconds"
			},
			{
				key: "degradeCooldownMaxMs",
				label: "row.policyDegradeMax",
				kind: "seconds"
			},
			{
				key: "softRateCooldownMs",
				label: "row.policySoftRate",
				kind: "seconds"
			},
			{
				key: "softRateCooldownMaxMs",
				label: "row.policySoftRateMax",
				kind: "seconds"
			},
			{
				key: "stickyTtlMs",
				label: "row.policySticky",
				kind: "seconds"
			},
			{
				key: "balanceAware",
				label: "row.policyBalanceAware",
				kind: "boolean"
			}
		];
		/** Policy values used before the first usage document arrives. */
		const FALLBACK_POLICY = {
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
			balanceAware: true
		};
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the settings.workbuddy2api locale namespace.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — `row.*` 的文案键约定与中英 1:1 键对齐（`zh: Record<Key, string>`
		*     强制双语同步）来自该项目（其继承自 dsh-connect-trae /
		*     dsh-subagent-default-model）。
		* 改动：文案按「账号池」改写：健康状态、权重、冷却、粘性、按账号积分。
		*
		* @module dsh-workbuddy2api/client/locales
		*/
		const en = {
			"row.title": "WorkBuddy account pool (dsh-workbuddy2api)",
			"row.desc": "Serve WorkBuddy models from a pool of locally signed-in accounts — weighted rotation, session stickiness, cooldown/breaker health, and per-account credits.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.empty": "No WorkBuddy sign-in found",
			"row.emptyHint": "Sign in once in the WorkBuddy desktop app, then press “Detect accounts again”.",
			"row.requestFailed": "Request failed",
			"row.accountsTitle": "Pooled accounts",
			"row.accountsHint": "Every locally detected sign-in. Tokens are never shown and never saved to DSH settings.",
			"row.accountsRescan": "Detect accounts again",
			"row.accountsScanning": "Detecting…",
			"row.stateReady": "Ready",
			"row.stateCooldown": "Cooling down",
			"row.stateDegraded": "Degraded",
			"row.stateMissing": "Credential missing",
			"row.stateDisabled": "Disabled",
			"row.accountEnabled": "Use",
			"row.accountWeight": "Weight",
			"row.accountInFlight": "In flight {count}",
			"row.accountSuccess": "OK {ok}",
			"row.accountFailure": "Failed {failed}",
			"row.accountCooldownUntil": "Cooldown until {at}",
			"row.accountBreakerUntil": "Breaker until {at}",
			"row.accountDegradedUntil": "Degraded until {at}",
			"row.accountLastError": "Last error: {message}",
			"row.accountReset": "Recover",
			"row.accountCredits": "Credits {credits}",
			"row.accountCreditsExpiring": "{credits} ({soon} expiring soon)",
			"row.accountCreditsUnknown": "Credits unknown",
			"row.accountExpires": "Token expires {at}",
			"row.refreshCredits": "Refresh credits",
			"row.refreshingCredits": "Refreshing credits…",
			"row.creditsError": "Credit query failed: {message}",
			"row.checkinClaim": "Check in",
			"row.checkinClaiming": "Checking in…",
			"row.checkinClaimed": "Checked in",
			"row.checkinError": "Check-in unavailable: {message}",
			"row.policyTitle": "Pool policy",
			"row.policyHint": "Health policy for the whole pool. Defaults follow workbuddy2api.",
			"row.policyInFlight": "In-flight ceiling per account",
			"row.policyInFlightGlobal": "In-flight ceiling per international account",
			"row.policyInFlightTotal": "In-flight ceiling for the pool",
			"row.policyBreaker": "Breaker: consecutive failures",
			"row.policyBreakerCooldown": "Breaker cooldown (s)",
			"row.policyBreakerMax": "Breaker cooldown ceiling (s)",
			"row.policyDegrade": "Degrade: consecutive failures",
			"row.policyDegradeCooldown": "Degrade duration (s)",
			"row.policyDegradeMax": "Degrade ceiling (s)",
			"row.policySoftRate": "Rate-limit cooldown (s)",
			"row.policySoftRateMax": "Rate-limit cooldown ceiling (s)",
			"row.policySticky": "Session stickiness TTL (s)",
			"row.policyBalanceAware": "Balance-aware ordering",
			"row.policyBalanceHint": "When on, accounts holding credits that expire soon are preferred, and idle accounts gain weight.",
			"row.modelsTitle": "Models",
			"row.modelsSummary": "{count} enabled",
			"row.modelsRefresh": "Refresh from WorkBuddy",
			"row.modelsRefreshing": "Refreshing models…",
			"row.discard": "Discard changes",
			"row.save": "Save",
			"row.saving": "Saving…",
			"row.saveError": "Save failed: {message}",
			"row.modelContext": "Maximum context {context}",
			"row.contextBudget": "DSH context budget",
			"row.modelOutput": "Output {output}",
			"row.modelRate": "{rate}x credits",
			"row.modelImage": "Image",
			"row.modelReasoning": "Reasoning: {efforts}",
			"row.modelUnknown": "Unknown",
			"row.modelCapabilityPending": "Only capabilities advertised by WorkBuddy are shown."
		};
		const zh = {
			"row.title": "WorkBuddy 账号池（dsh-workbuddy2api）",
			"row.desc": "用本机已登录的多个 WorkBuddy 账号共同提供模型：加权轮换、会话粘性、冷却/熔断健康度与按账号积分。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.empty": "没有检测到 WorkBuddy 登录",
			"row.emptyHint": "在 WorkBuddy 桌面 App 里登录一次，然后点「重新检测账号」。",
			"row.requestFailed": "请求失败",
			"row.accountsTitle": "池内账号",
			"row.accountsHint": "本机检测到的全部登录账号。Token 不会显示，也不会保存到 DSH 设置。",
			"row.accountsRescan": "重新检测账号",
			"row.accountsScanning": "正在检测…",
			"row.stateReady": "可用",
			"row.stateCooldown": "冷却中",
			"row.stateDegraded": "降权中",
			"row.stateMissing": "凭据缺失",
			"row.stateDisabled": "已停用",
			"row.accountEnabled": "启用",
			"row.accountWeight": "权重",
			"row.accountInFlight": "在途 {count}",
			"row.accountSuccess": "成功 {ok}",
			"row.accountFailure": "失败 {failed}",
			"row.accountCooldownUntil": "冷却至 {at}",
			"row.accountBreakerUntil": "熔断至 {at}",
			"row.accountDegradedUntil": "降权至 {at}",
			"row.accountLastError": "最近错误：{message}",
			"row.accountReset": "恢复",
			"row.accountCredits": "积分 {credits}",
			"row.accountCreditsExpiring": "{credits}（其中 {soon} 即将过期）",
			"row.accountCreditsUnknown": "积分未知",
			"row.accountExpires": "令牌 {at} 过期",
			"row.refreshCredits": "刷新积分",
			"row.refreshingCredits": "正在刷新积分…",
			"row.creditsError": "积分查询失败：{message}",
			"row.checkinClaim": "立即签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinClaimed": "今日已签到",
			"row.checkinError": "签到状态获取失败：{message}",
			"row.policyTitle": "池策略",
			"row.policyHint": "整池共享的健康策略，默认值来自 workbuddy2api。",
			"row.policyInFlight": "单账号在途上限",
			"row.policyInFlightGlobal": "国际版账号在途上限",
			"row.policyInFlightTotal": "整池在途上限",
			"row.policyBreaker": "熔断：连续失败次数",
			"row.policyBreakerCooldown": "熔断时长（秒）",
			"row.policyBreakerMax": "熔断时长上限（秒）",
			"row.policyDegrade": "降权：连续失败次数",
			"row.policyDegradeCooldown": "降权时长（秒）",
			"row.policyDegradeMax": "降权时长上限（秒）",
			"row.policySoftRate": "限流冷却基数（秒）",
			"row.policySoftRateMax": "限流冷却上限（秒）",
			"row.policySticky": "会话粘性 TTL（秒）",
			"row.policyBalanceAware": "按余额排序",
			"row.policyBalanceHint": "开启后，持有即将过期积分的账号优先被使用，久未使用的账号获得闲置权重。",
			"row.modelsTitle": "模型",
			"row.modelsSummary": "已启用 {count} 个",
			"row.modelsRefresh": "从 WorkBuddy 刷新",
			"row.modelsRefreshing": "正在刷新模型…",
			"row.discard": "放弃修改",
			"row.save": "保存",
			"row.saving": "保存中…",
			"row.saveError": "保存失败：{message}",
			"row.modelContext": "最大上下文 {context}",
			"row.contextBudget": "DSH 上下文预算",
			"row.modelOutput": "最大输出 {output}",
			"row.modelRate": "积分 {rate}x",
			"row.modelImage": "图片",
			"row.modelReasoning": "推理强度：{efforts}",
			"row.modelUnknown": "未知",
			"row.modelCapabilityPending": "仅展示 WorkBuddy 接口明确公布的模型能力。"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy2api-client";
		/** Client services required by the Plugin configuration contribution. */
		const inject = [
			"slots",
			"locale",
			"settingsScope"
		];
		/** Register card copy and the pool card under Plugin configuration. */
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy2api";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy2api: settings copy");
				const t = ctx.locale.bind(namespace);
				const settingsScope = ctx.settingsScope.bind({ namespace: "workbuddy2api" });
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy2api",
					priority: 30,
					inject: () => ({
						t,
						settingsScope
					})
				}, WorkBuddyPoolCard));
			} catch (error) {
				console.error("[dsh-workbuddy2api] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
