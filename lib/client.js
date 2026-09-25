window.__ModuleLoader__.load({
	id: "dsh-workbuddy2api",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		/** Plugin-owned web sign-in start endpoint: returns an authorization URL. */
		const WORKBUDDY2API_LOGIN_START_PATH = "/plugins/dsh-workbuddy2api/login/start";
		/** Plugin-owned web sign-in poll endpoint: reports progress and finishes it. */
		const WORKBUDDY2API_LOGIN_POLL_PATH = "/plugins/dsh-workbuddy2api/login/poll";
		/** Query parameter carrying the sign-in state a poll addresses. */
		const WORKBUDDY2API_STATE_PARAM = "state";
		/** Plugin-owned growth-task list endpoint. */
		const WORKBUDDY2API_TASKS_PATH = "/plugins/dsh-workbuddy2api/tasks";
		/** Plugin-owned growth-task run endpoint (one-click finish). */
		const WORKBUDDY2API_TASKS_RUN_PATH = "/plugins/dsh-workbuddy2api/tasks/run";
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
.dsm-plugin-card>div.dsm-plugin-card-header{cursor:default;box-sizing:border-box}
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
/* The region summary line: pool-wide credits, between the tabs and accounts. */
.dsm-wb2api-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-wb2api-summary-text{flex:1;min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:19px;font-variant-numeric:tabular-nums}
.dsm-wb2api-summary-accounts{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-wb2api-tab{appearance:none;font:inherit;cursor:pointer;flex:1;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .15s,background .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-wb2api-tab:hover:not(.dsm-wb2api-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-wb2api-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-wb2api-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline}
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
.dsm-wb2api-credits{display:inline-flex;align-items:center;gap:5px}
.dsm-wb2api-ring{flex:none;display:block}
.dsm-wb2api-account-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dsm-wb2api-switch{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-switch input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-weight{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-weight input{width:56px;font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-account-hint{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A model-level refusal is not an account fault, so it reads as a warning. */
.dsm-wb2api-account-hint-model{color:#c98a2b}
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
.dsm-wb2api-signin{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:11px 12px;border:1px dashed var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-wb2api-signin-text{flex:1;min-width:180px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-signin-status{flex:1;min-width:180px;display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-wb2api-spinner{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#3a3d45);border-top-color:var(--dsw-alias-brand-primary,#5686fe);animation:dsm-wb2api-spin .8s linear infinite}
@keyframes dsm-wb2api-spin{to{transform:rotate(360deg)}}
.dsm-wb2api-signin-done{flex:1;min-width:180px;color:var(--dsw-alias-state-success-primary,#22a06b);font-size:12px;line-height:18px}
.dsm-wb2api-tasks{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
/* The hidden attribute is only a UA style ([hidden]{display:none}), so an
   author display on the same element silently wins and it stays visible --
   which is exactly how the task list stayed expanded while its header already
   said collapsed. The paired [hidden] rule (higher specificity) hides it. */
.dsm-wb2api-tasks-body{display:flex;flex-direction:column;gap:12px}
.dsm-wb2api-tasks-body[hidden]{display:none}
.dsm-wb2api-section-toggle{appearance:none;font:inherit;text-align:left;cursor:pointer;flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px;padding:0;border:0;background:transparent;color:inherit}
.dsm-wb2api-section-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px;border-radius:6px}
.dsm-wb2api-section-toggle-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsm-wb2api-section-chevron{flex:none;display:inline-flex;margin-top:2px;color:var(--dsw-alias-label-tertiary,#999);transition:transform .16s}
.dsm-wb2api-section-chevron-open{transform:rotate(180deg)}
.dsm-wb2api-task-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-wb2api-task{display:flex;flex-direction:column;gap:5px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-wb2api-task+.dsm-wb2api-task{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-wb2api-task-done{opacity:.6}
.dsm-wb2api-task-head{display:flex;align-items:center;gap:9px;min-width:0}
.dsm-wb2api-task-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-wb2api-task-spacer{flex:1;min-width:0}
.dsm-wb2api-task-progress{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-wb2api-task-reward{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-task-detail{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-task-report{margin:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-wb2api-task-report-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-wb2api-task-schedule{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 14px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#24262c)}
/* The schedule is a sibling of the roster, not part of it: it stays visible
   while the roster is collapsed, so it carries its own heading. */
.dsm-wb2api-task-schedule-title{grid-column:1/-1;margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;font-weight:600;line-height:18px}
.dsm-wb2api-task-schedule label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-wb2api-task-schedule input[type=number]{width:64px;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-task-schedule input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-task-schedule-note{grid-column:1/-1;margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
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
		*   — 卡片结构（折叠外壳 / 账号状态行 / 积分区 / 模型表 / 操作按钮行）、
		*     加载时注入一次 `<style>`、草稿态与 dirty 标记的保存流程、
		*     60 秒轮询与 AbortController 清理、区域 tab 栏与按区域隔离的草稿，
		*     均来自该项目。
		* 改动：每个 tab 不再只是「换个账号看同一份目录」，而是一个**独立账号池**：
		*   该区域自己的 provider、账号、健康、权重、积分、策略与模型目录。
		*   切 tab 不会触碰另一个池的任何状态。
		*
		* @module dsh-workbuddy2api/client/WorkBuddyPoolCard
		*/
		const POLL_INTERVAL_MS = 6e4;
		/** Keep this small glyph local: DSH renamed its icon exports in 0.1.7. */
		function ChevronDown() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: "14",
				height: "14",
				viewBox: "0 0 14 14",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "m3 5 4 4 4-4",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		/** How often a running browser sign-in is checked, while the card is open. */
		const LOGIN_POLL_INTERVAL_MS = 3e3;
		/**
		* The authorization page, remembered across the redirect. The user finishes
		* the sign-in in a browser tab and comes back to the harness, which reloads
		* the page — a sign-in kept only in component state would be lost, leaving a
		* credential on the server that the card no longer knows about.
		*/
		const LOGIN_STORAGE_KEY = "dsh-workbuddy2api/login";
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
		/** Read the remembered sign-in, ignoring anything unreadable. */
		function readStoredLogin() {
			if (typeof window === "undefined") return void 0;
			try {
				const raw = window.localStorage.getItem(LOGIN_STORAGE_KEY);
				if (raw === null) return void 0;
				const parsed = JSON.parse(raw);
				if (typeof parsed.state !== "string" || typeof parsed.url !== "string") return void 0;
				if (parsed.region !== "cn" && parsed.region !== "global") return void 0;
				return {
					region: parsed.region,
					state: parsed.state,
					url: parsed.url,
					status: parsed.status === "error" ? "error" : "waiting",
					...typeof parsed.message === "string" ? { message: parsed.message } : {},
					...parsed.fatal === true ? { fatal: true } : {}
				};
			} catch {
				return;
			}
		}
		/** Remember or forget the running sign-in. */
		function writeStoredLogin(draft) {
			if (typeof window === "undefined") return;
			try {
				if (draft === void 0) window.localStorage.removeItem(LOGIN_STORAGE_KEY);
				else window.localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(draft));
			} catch {}
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
		/**
		* A small ring showing how much of an account's granted credit allowance is
		* left. One stroked circle with a dash offset; the geometry is in viewBox units
		* so the icon scales with the surrounding text.
		*/
		function CreditRing({ ratio, title, size = 14 }) {
			const radius = 6;
			const circumference = 2 * Math.PI * radius;
			const share = ratio === void 0 ? 0 : Math.min(Math.max(ratio, 0), 1);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				className: "dsm-wb2api-ring",
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				role: "img",
				"aria-label": title,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: title }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "8",
						r: radius,
						fill: "none",
						stroke: "var(--dsw-alias-border-l2,#3a3d45)",
						strokeWidth: "3"
					}),
					ratio === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "8",
						r: radius,
						fill: "none",
						stroke: share >= .5 ? "#22a06b" : share >= .2 ? "#c98a2b" : "#d92d20",
						strokeWidth: "3",
						strokeLinecap: "round",
						strokeDasharray: String(circumference * share) + " " + String(circumference),
						transform: "rotate(-90 8 8)"
					})
				]
			});
		}
		/**
		* A finite integer inside `[min, max]`, or `fallback` when the input is not a
		* usable number. Used before every settings write: the codec is strict, so a
		* half-typed field must be normalized rather than forwarded.
		*/
		function clampInteger(value, min, max, fallback) {
			if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
			return Math.min(Math.max(Math.round(value), min), max);
		}
		/**
		* The schedule document, but only when it carries the numeric fields the card
		* edits. An older host answered `dailyAt` alone; rendering that would show
		* empty time boxes and would also spread `undefined` into the settings write.
		*/
		function usableSchedule(schedule) {
			if (schedule === void 0) return void 0;
			if (typeof schedule.hour !== "number" || typeof schedule.minute !== "number") return void 0;
			return schedule;
		}
		/** The empty placeholder each tab starts from. */
		function emptyUsage(region) {
			return {
				status: "empty",
				region,
				accounts: [],
				pool: []
			};
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
		/** Render the two account pools, their credits, policies, and model selection. */
		function WorkBuddyPoolCard({ t, settingsScope, page }) {
			if (t === void 0) throw new Error("WorkBuddy pool card requires its translation function");
			const asPage = page === true;
			const Container = asPage ? "section" : "li";
			const Header = asPage ? "div" : "button";
			const [open, setOpen] = (0, react.useState)(asPage);
			const [activeRegion, setActiveRegion] = (0, react.useState)("cn");
			/** Last-known usage per region, so tab dots survive tab switches. */
			const [statusByRegion, setStatusByRegion] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(false);
			const [settingsRevision, setSettingsRevision] = (0, react.useState)(0);
			/** Per-region unsaved pool edits; a draft on one tab is never dropped by
			* switching to the other tab, only by that tab's discard/save. */
			const [poolDrafts, setPoolDrafts] = (0, react.useState)({});
			const [modelDrafts, setModelDrafts] = (0, react.useState)({});
			const [saving, setSaving] = (0, react.useState)(false);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [refreshingCredits, setRefreshingCredits] = (0, react.useState)(false);
			const [checkingIn, setCheckingIn] = (0, react.useState)(void 0);
			const [actionError, setActionError] = (0, react.useState)(void 0);
			/** The running browser sign-in, if any; survives a page reload. */
			const [login, setLogin] = (0, react.useState)(() => readStoredLogin());
			/** A finished sign-in's confirmation line, cleared by the next action. */
			const [loginDone, setLoginDone] = (0, react.useState)(void 0);
			/** Per-region growth tasks, loaded on demand (never on the 60s poll). */
			const [tasksByRegion, setTasksByRegion] = (0, react.useState)({});
			const [tasksBusy, setTasksBusy] = (0, react.useState)(false);
			/**
			* Whether the task list is expanded, per region. Default COLLAPSED: a full
			* roster is ~18 rows, which would otherwise push the policy and model
			* sections off the screen every time the card is opened.
			*/
			const [tasksOpen, setTasksOpen] = (0, react.useState)({});
			/** The account a task run is currently sweeping, when it is one account. */
			const [tasksBusyAccount, setTasksBusyAccount] = (0, react.useState)(void 0);
			const [taskDraft, setTaskDraft] = (0, react.useState)({});
			const mounted = (0, react.useRef)(true);
			/**
			* The authoritative "which sign-in is running" record. It is written
			* synchronously on every deliberate change, never derived from the rendered
			* state: a poll answer that lands after the sign-in it belongs to was
			* replaced or cancelled must not be able to touch the card, and comparing
			* against a value that only updates on the next render would leave a window
			* where a stale answer still looks current.
			*/
			const loginRef = (0, react.useRef)(login);
			const rememberLogin = (0, react.useCallback)((draft) => {
				loginRef.current = draft;
				writeStoredLogin(draft);
				if (mounted.current) setLogin(draft);
			}, []);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => settingsScope?.subscribe(() => {
				setSettingsRevision((value) => value + 1);
			}), [settingsScope]);
			const refreshUsage = (0, react.useCallback)(async (region, signal) => {
				try {
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_USAGE_PATH, region), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const document = value;
					if (mounted.current && signal?.aborted !== true) setStatusByRegion((previous) => ({
						...previous,
						[region]: document
					}));
					return document;
				} catch (error) {
					if (mounted.current && signal?.aborted !== true) setStatusByRegion((previous) => ({
						...previous,
						[region]: {
							status: "error",
							region,
							message: error instanceof Error ? error.message : t("row.requestFailed")
						}
					}));
					return;
				}
			}, [t]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refreshUsage(activeRegion, controller.signal);
				return () => {
					controller.abort();
				};
			}, [
				open,
				activeRegion,
				refreshUsage
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					for (const region of WORKBUDDY2API_REGIONS) refreshUsage(region, controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [open, refreshUsage]);
			/** Poll the running sign-in once and apply whatever it answered. */
			const pollLogin = (0, react.useCallback)(async (draft) => {
				const region = draft.region;
				/**
				* Whether this answer still belongs to the sign-in the card is tracking.
				* The poller fires on a timer, so several requests are always in flight
				* around the moment a sign-in completes; the ones that lost the race must
				* be dropped rather than reported.
				*/
				const stillCurrent = () => loginRef.current?.state === draft.state;
				const path = withWorkBuddyRegion(WORKBUDDY2API_LOGIN_POLL_PATH, region);
				let response;
				try {
					response = await fetch(`${path}&${WORKBUDDY2API_STATE_PARAM}=${encodeURIComponent(draft.state)}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
				} catch (error) {
					if (mounted.current && stillCurrent()) rememberLogin({
						...draft,
						status: "error",
						message: error instanceof Error ? error.message : t("row.requestFailed")
					});
					return;
				}
				const body = await response.json().catch(() => void 0);
				if (!response.ok) {
					if (!stillCurrent()) return;
					rememberLogin({
						...draft,
						status: "error",
						message: body?.error ?? `HTTP ${response.status}`,
						...response.status === 400 || response.status === 404 ? { fatal: true } : {}
					});
					return;
				}
				const document = body;
				if (!stillCurrent()) return;
				if (document.status === "waiting") {
					rememberLogin({
						...draft,
						status: "waiting",
						...document.message === void 0 ? {} : { message: document.message }
					});
					return;
				}
				if (document.status === "done") {
					rememberLogin(void 0);
					if (mounted.current) {
						setLoginDone({
							region,
							text: t("row.signInDone", { account: document.account.accountName })
						});
						if (document.note !== void 0) setActionError(document.note);
					}
					await refreshUsage(region);
					return;
				}
				if (document.status === "error") rememberLogin({
					...draft,
					status: "error",
					message: document.message
				});
			}, [
				rememberLogin,
				refreshUsage,
				t
			]);
			(0, react.useEffect)(() => {
				if (login === void 0) return;
				const controller = new AbortController();
				/**
				* Whether a request for this sign-in is still travelling. The poller is
				* what keeps a finished sign-in from being polled twice at once — the host
				* refuses the second request, but there is no reason to send it.
				*/
				let inflight = false;
				const tick = () => {
					const current = loginRef.current;
					if (current === void 0 || current.fatal === true || controller.signal.aborted) return;
					if (inflight) return;
					inflight = true;
					pollLogin(current).finally(() => {
						inflight = false;
					});
				};
				tick();
				const timer = window.setInterval(tick, LOGIN_POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				login?.state,
				login?.region,
				pollLogin
			]);
			/** Load one region's task document (list + schedule + last reports). */
			const loadTasks = (0, react.useCallback)(async (region) => {
				try {
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_TASKS_PATH, region), {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					if (!mounted.current) return;
					setTasksByRegion((previous) => ({
						...previous,
						[region]: {
							accounts: Array.isArray(body?.accounts) ? body.accounts : [],
							...body?.schedule === void 0 || body.schedule === null ? {} : { schedule: body.schedule },
							reports: body?.schedule?.lastReports ?? []
						}
					}));
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				}
			}, [t]);
			/** Run the tasks: this account's, or every account in the region. */
			const runTasks = async (accountId) => {
				setTasksBusy(true);
				setTasksBusyAccount(accountId);
				setActionError(void 0);
				try {
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_TASKS_RUN_PATH, activeRegion), {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify(accountId === void 0 ? {} : { accountId })
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					if (!mounted.current) return;
					setTasksByRegion((previous) => ({
						...previous,
						[activeRegion]: {
							accounts: Array.isArray(body?.accounts) ? body.accounts : previous[activeRegion]?.accounts ?? [],
							...body?.schedule === void 0 ? {} : { schedule: body.schedule },
							reports: Array.isArray(body?.reports) ? body.reports : []
						}
					}));
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) {
						setTasksBusy(false);
						setTasksBusyAccount(void 0);
					}
				}
			};
			const startLogin = async () => {
				setActionError(void 0);
				setLoginDone(void 0);
				try {
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_LOGIN_START_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok || typeof body?.url !== "string" || typeof body.state !== "string") throw new Error(body?.error ?? `HTTP ${response.status}`);
					rememberLogin({
						region: activeRegion,
						state: body.state,
						url: body.url,
						status: "waiting"
					});
					if (window.open(body.url, "_blank", "noopener,noreferrer") === null) {
						if (mounted.current) setActionError(t("row.signInBlocked"));
					}
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				}
			};
			const cancelLogin = () => {
				rememberLogin(void 0);
			};
			const usage = statusByRegion[activeRegion] ?? emptyUsage(activeRegion);
			const writable = settingsScope?.getSnapshot().writable === true;
			const entries = usage.status === "ready" || usage.status === "empty" ? usage.pool : [];
			const savedPoolState = usage.status === "ready" ? usage.poolState : [];
			const savedPolicy = usage.status === "ready" ? usage.policy : void 0;
			const poolDraft = poolDrafts[activeRegion];
			const modelDraft = modelDrafts[activeRegion];
			const activeAccounts = poolDraft?.accounts ?? new Map(entries.map((entry) => [entry.accountId, {
				enabled: entry.enabled,
				weight: entry.weight
			}]));
			const activePolicy = poolDraft?.policy ?? savedPolicy;
			/** The context budgets saved in settings for the active region. */
			function savedContextBudgets() {
				const value = (settingsScope?.getSnapshot().value)?.regions?.[activeRegion]?.contextBudgets;
				return typeof value === "object" && value !== null ? value : {};
			}
			const editPool = (edit) => {
				setPoolDrafts((previous) => ({
					...previous,
					[activeRegion]: edit(previous[activeRegion] ?? {
						accounts: new Map(entries.map((entry) => [entry.accountId, {
							enabled: entry.enabled,
							weight: entry.weight
						}])),
						policy: savedPolicy ?? FALLBACK_POLICY
					})
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
			const editModels = (edit) => {
				setModelDrafts((previous) => ({
					...previous,
					[activeRegion]: edit(previous[activeRegion] ?? {
						models: usage.status === "ready" ? [...usage.models] : [],
						enabledIds: new Set(usage.status === "ready" ? usage.enabledModelIds : []),
						imageIds: new Set(usage.status === "ready" ? usage.imageModelIds : []),
						contextBudgets: savedContextBudgets()
					})
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
			const discard = () => {
				setPoolDrafts((previous) => {
					const next = { ...previous };
					delete next[activeRegion];
					return next;
				});
				setModelDrafts((previous) => {
					const next = { ...previous };
					delete next[activeRegion];
					return next;
				});
			};
			const saveAll = async () => {
				if (settingsScope === void 0) return;
				setSaving(true);
				setSaveError(void 0);
				try {
					const configured = settingsScope.getSnapshot().value;
					const configuredRegions = typeof configured?.regions === "object" && configured.regions !== null ? configured.regions : {};
					const slot = { ...configuredRegions[activeRegion] ?? {} };
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
						slot.poolState = records;
						slot.pool = { ...poolDraft.policy };
					}
					if (modelDraft !== void 0) {
						slot.lastCatalog = modelDraft.models.map(toPersistedWorkBuddyModel);
						slot.enabledModelIds = [...modelDraft.enabledIds];
						slot.imageModelIds = [...modelDraft.imageIds];
						slot.contextBudgets = modelDraft.contextBudgets;
					}
					await settingsScope.set("regions", {
						...configuredRegions,
						[activeRegion]: slot
					});
					setPoolDrafts((previous) => {
						const next = { ...previous };
						delete next[activeRegion];
						return next;
					});
					setModelDrafts((previous) => {
						const next = { ...previous };
						delete next[activeRegion];
						return next;
					});
					await refreshUsage(activeRegion);
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
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_ACCOUNTS_REFRESH_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refreshUsage(activeRegion);
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
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_CREDITS_REFRESH_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setRefreshingCredits(false);
				}
			};
			const resetAccount = async (accountId) => {
				setActionError(void 0);
				try {
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_POOL_ACTION_PATH, activeRegion), {
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
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				}
			};
			const claimCheckin = async (accountId) => {
				setCheckingIn(accountId);
				setActionError(void 0);
				try {
					const path = withWorkBuddyRegion(WORKBUDDY2API_CHECKIN_PATH, activeRegion);
					const response = await fetch(`${path}&${WORKBUDDY2API_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`, {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					await refreshUsage(activeRegion);
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
					const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_MODELS_REFRESH_PATH, activeRegion), {
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
					setModelDrafts((previous) => ({
						...previous,
						[activeRegion]: {
							models: fresh,
							enabledIds: new Set([...source?.enabledIds ?? []].filter((id) => freshIds.has(id))),
							imageIds: new Set([...source?.imageIds ?? []].filter((id) => freshIds.has(id))),
							contextBudgets: stillBudgets
						}
					}));
				} catch (error) {
					if (mounted.current) setActionError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const taskState = tasksByRegion[activeRegion];
			const tasksExpanded = tasksOpen[activeRegion] === true;
			(0, react.useEffect)(() => {
				if (!open) return;
				if (tasksByRegion[activeRegion] !== void 0) return;
				loadTasks(activeRegion);
			}, [
				open,
				activeRegion,
				tasksByRegion,
				loadTasks
			]);
			/** Summary for the collapsed header: how far along this region's tasks are. */
			const taskSummary = (() => {
				const accounts = (taskState?.accounts ?? []).filter((account) => account.supported);
				let done = 0;
				let total = 0;
				let claimable = 0;
				for (const account of accounts) for (const task of account.tasks) {
					total += 1;
					if (task.claimed || task.target > 0 && task.current >= task.target) done += 1;
					if (task.claimable) claimable += 1;
				}
				return {
					done,
					total,
					claimable,
					accounts: accounts.length
				};
			})();
			/**
			* The schedule the card renders. A document from an older host carries only
			* `dailyAt` (a formatted string) and no numbers, which rendered as empty time
			* boxes; such a document is treated as absent rather than shown half-empty.
			*/
			const schedule = taskDraft[activeRegion] ?? usableSchedule(taskState?.schedule);
			const reportsByAccount = new Map((taskState?.reports ?? []).map((report) => [report.accountId, report]));
			/** Persist the schedule draft (and re-arm the host's timers). */
			const saveSchedule = async (next) => {
				if (settingsScope === void 0) return;
				const hour = clampInteger(next.hour, 0, 23, 0);
				const minute = clampInteger(next.minute, 0, 59, 0);
				const enabled = next.enabled === true;
				const runOnStart = next.runOnStart === true;
				setTaskDraft((previous) => ({
					...previous,
					[activeRegion]: {
						...next,
						enabled,
						hour,
						minute,
						runOnStart
					}
				}));
				try {
					const configured = settingsScope.getSnapshot().value;
					await settingsScope.set("tasks", {
						...typeof configured?.tasks === "object" && configured.tasks !== null ? configured.tasks : {},
						enabled,
						hour,
						minute,
						runOnStart
					});
				} catch (error) {
					if (mounted.current) setSaveError(error instanceof Error ? error.message : t("row.requestFailed"));
					return;
				}
				setTaskDraft((previous) => {
					const copy = { ...previous };
					delete copy[activeRegion];
					return copy;
				});
				await loadTasks(activeRegion);
			};
			const title = t("row.title");
			const visibleModels = modelDraft?.models ?? (usage.status === "ready" ? usage.models : []);
			const activeEnabledIds = modelDraft?.enabledIds ?? new Set(usage.status === "ready" ? usage.enabledModelIds : []);
			const activeImageIds = modelDraft?.imageIds ?? new Set(usage.status === "ready" ? usage.imageModelIds : []);
			const activeContextBudgets = modelDraft?.contextBudgets ?? savedContextBudgets();
			const creditsByAccount = new Map((usage.status === "ready" ? usage.credits : []).map((credit) => [credit.accountId, credit]));
			/**
			* The region's total: every PRESENT account's credits over the allowance they
			* were granted.
			*
			* Two honesty rules, same as the per-account ring:
			*   - credits are cached on demand, so accounts nobody has queried yet are
			*     reported separately rather than silently counted as zero;
			*   - an allowance the sum cannot cover (total > capacity) means the ratio is
			*     unknown, not "over 100%".
			*/
			const creditsTotal = (() => {
				const present = entries.filter((entry) => entry.present);
				let total = 0;
				let capacity = 0;
				let known = 0;
				let unknown = 0;
				for (const entry of present) {
					const credits = creditsByAccount.get(entry.accountId)?.credits;
					if (credits === void 0) {
						unknown += 1;
						continue;
					}
					known += 1;
					total += credits.total;
					capacity += credits.capacity;
				}
				const ratio = known === 0 || capacity <= 0 || total > capacity ? void 0 : total / capacity;
				return {
					total,
					capacity,
					known,
					unknown,
					ratio,
					accounts: present.length
				};
			})();
			const creditsTotalPercent = creditsTotal.ratio === void 0 ? 0 : Math.round(creditsTotal.ratio * 100);
			const creditsTotalRingTitle = creditsTotal.known === 0 ? t("row.creditsRatioUnknown") : creditsTotal.ratio === void 0 ? t("row.creditsRatioUnknown") : t("row.creditsRatio", { percent: creditsTotalPercent });
			const dirty = poolDraft !== void 0 || modelDraft !== void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Container, {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Header, {
					...asPage ? {} : {
						type: "button",
						"aria-expanded": open,
						"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${title}`,
						onClick: () => {
							setOpen(!open);
						}
					},
					className: "dsm-plugin-card-header",
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
						!asPage && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronDown, {})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					hidden: !open && !asPage,
					children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-wb2api-root",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-wb2api-tabs",
								role: "tablist",
								"aria-label": title,
								children: WORKBUDDY2API_REGIONS.map((region) => {
									const regionUsage = statusByRegion[region];
									const dot = regionUsage === void 0 ? "var(--dsw-alias-label-dimmed, #9aa0a6)" : regionUsage.status === "ready" ? "var(--dsw-alias-state-success-primary, #22a06b)" : regionUsage.status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)";
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										role: "tab",
										"aria-selected": region === activeRegion,
										className: `dsm-wb2api-tab${region === activeRegion ? " dsm-wb2api-tab-active" : ""}`,
										onClick: () => {
											setActiveRegion(region);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-hidden": "true",
											className: "dsm-wb2api-tab-dot",
											style: { background: dot }
										}), region === "cn" ? t("row.tabCn") : t("row.tabGlobal")]
									}, region);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-wb2api-section-sub",
								children: t("row.tabHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-wb2api-summary",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditRing, {
										ratio: creditsTotal.ratio,
										title: creditsTotalRingTitle,
										size: 18
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsm-wb2api-summary-text",
										children: [creditsTotal.known === 0 ? t("row.creditsTotalUnknown") : creditsTotal.ratio === void 0 ? t("row.creditsTotalNoRatio", { credits: formatNumber(creditsTotal.total) }) : t("row.creditsTotal", {
											credits: formatNumber(creditsTotal.total),
											capacity: formatNumber(creditsTotal.capacity),
											percent: creditsTotalPercent
										}), creditsTotal.unknown === 0 ? "" : " · " + t("row.creditsTotalPartial", { count: creditsTotal.unknown })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-wb2api-summary-accounts",
										children: t("row.creditsTotalAccounts", { count: creditsTotal.accounts })
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-wb2api-section",
								"aria-label": t("row.accountsTitle"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-section-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: "dsm-wb2api-section-title",
											children: t("row.accountsTitle")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-wb2api-section-sub",
											children: t("row.providerLabel", { provider: activeRegion === "global" ? "workbuddy2api-global" : "workbuddy2api" })
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
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-signin",
										children: [
											login === void 0 || login.region !== activeRegion ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-wb2api-signin-text",
												children: t("row.signInHint", { region: activeRegion === "cn" ? t("row.tabCn") : t("row.tabGlobal") })
											}) : login.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-wb2api-signin-status",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-wb2api-error",
													children: login.message
												})
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsm-wb2api-signin-status",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-wb2api-spinner",
													"aria-hidden": "true"
												}), t("row.signInWaiting")]
											}),
											loginDone === void 0 || loginDone.region !== activeRegion ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-wb2api-signin-done",
												children: loginDone.text
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dsm-wb2api-actions-buttons",
												children: login === void 0 || login.region !== activeRegion ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-primary",
													disabled: busy,
													onClick: () => {
														startLogin();
													},
													children: t("row.signIn")
												}) : login.fatal === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-primary",
													disabled: busy,
													onClick: () => {
														startLogin();
													},
													children: t("row.signIn")
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													onClick: () => {
														window.open(login.url, "_blank", "noopener,noreferrer");
													},
													children: t("row.signInOpen")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													onClick: cancelLogin,
													children: t("row.signInCancel")
												})] })
											})
										]
									}),
									entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-wb2api-text",
										children: usage.status === "empty" ? usage.message ?? t("row.emptyHint") : t("row.empty")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-wb2api-account-list",
										children: entries.map((entry) => {
											const edited = activeAccounts.get(entry.accountId);
											const enabled = edited?.enabled ?? entry.enabled;
											const weight = edited?.weight ?? entry.weight;
											const credit = creditsByAccount.get(entry.accountId);
											const capacity = credit?.credits?.capacity ?? 0;
											const total = credit?.credits?.total;
											const ratio = total === void 0 || capacity <= 0 || total > capacity ? void 0 : total / capacity;
											const percent = ratio === void 0 ? 0 : Math.round(ratio * 100);
											const ringTitle = ratio === void 0 ? t("row.creditsRatioUnknown") : t("row.creditsRatio", { percent });
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
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: "dsm-wb2api-credits",
																children: credit?.credits === void 0 ? t("row.accountCreditsUnknown") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditRing, {
																	ratio,
																	title: ringTitle
																}), credit.credits.expiringSoon > 0 ? t("row.accountCreditsExpiring", {
																	credits: formatNumber(credit.credits.total),
																	soon: formatNumber(credit.credits.expiringSoon)
																}) : t("row.accountCredits", { credits: formatNumber(credit.credits.total) })] })
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: "dsm-btn dsm-btn-outline",
																disabled: checkingIn !== void 0,
																onClick: () => {
																	claimCheckin(entry.accountId);
																},
																children: checkingIn === entry.accountId ? t("row.checkinClaiming") : t("row.checkinClaim")
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: "dsm-btn dsm-btn-outline",
																disabled: tasksBusy,
																onClick: () => {
																	runTasks(entry.accountId);
																},
																children: tasksBusyAccount === entry.accountId ? t("row.taskRunAccountBusy") : t("row.taskRunAccount")
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
													}),
													entry.modelCooldowns === void 0 || entry.modelCooldowns.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "dsm-wb2api-account-hint dsm-wb2api-account-hint-model",
														title: t("row.accountModelCooldownHint"),
														children: [
															t("row.accountModelCooldowns"),
															": ",
															entry.modelCooldowns.map((cooldown) => t("row.accountModelCooldown", {
																model: cooldown.model,
																at: formatDateTime(cooldown.untilMs)
															})).join(" · ")
														]
													})
												]
											}, entry.accountId);
										})
									})
								]
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
															name: `context-${activeRegion}-${model.id}`,
															checked: (activeContextBudgets[model.id] ?? 2e5) === 2e5,
															disabled: !writable || saving,
															onChange: () => {
																setContextBudget(model.id, 2e5);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "200K" })] }) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "radio",
															name: `context-${activeRegion}-${model.id}`,
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-wb2api-tasks",
								"aria-label": t("row.tasksTitle"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-section-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsm-wb2api-section-toggle",
											"aria-expanded": tasksExpanded,
											onClick: () => {
												setTasksOpen((previous) => ({
													...previous,
													[activeRegion]: !tasksExpanded
												}));
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												className: `dsm-wb2api-section-chevron${tasksExpanded ? " dsm-wb2api-section-chevron-open" : ""}`,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronDown, {})
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsm-wb2api-section-toggle-text",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dsm-wb2api-section-title",
													children: [
														t("row.tasksTitle"),
														taskSummary.total === 0 ? "" : " · " + t("row.tasksSummary", {
															done: taskSummary.done,
															total: taskSummary.total
														}),
														taskSummary.claimable === 0 ? "" : " · " + t("row.tasksClaimableCount", { count: taskSummary.claimable })
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dsm-wb2api-section-sub",
													children: [tasksExpanded ? t("row.tasksHint") : t("row.tasksHintCollapsed"), schedule === void 0 ? "" : " · " + (schedule.running ? t("row.tasksAutoRunning") : schedule.enabled ? t("row.tasksAutoAtShort", { at: schedule.dailyAt }) : t("row.tasksAutoOff"))]
												})]
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-wb2api-actions-buttons",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsm-btn dsm-btn-outline",
												disabled: tasksBusy,
												onClick: () => {
													loadTasks(activeRegion);
												},
												children: tasksBusy ? t("row.tasksRefreshing") : t("row.tasksRefresh")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsm-btn dsm-btn-primary",
												disabled: tasksBusy,
												onClick: () => {
													runTasks();
												},
												children: tasksBusy ? t("row.tasksRunning") : t("row.tasksRun")
											})]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-wb2api-tasks-body",
										hidden: !tasksExpanded,
										children: taskState === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-wb2api-text",
											children: t("row.tasksRefreshing")
										}) : taskState.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-wb2api-text",
											children: t("row.tasksEmpty")
										}) : taskState.accounts.map((account) => {
											if (!account.supported) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsm-wb2api-text",
												children: t("row.tasksIntl")
											}, account.accountId);
											const report = reportsByAccount.get(account.accountId);
											const resultsByCode = new Map((report?.results ?? []).map((result) => [result.taskCode, result]));
											const done = account.tasks.filter((task) => task.claimed || task.target > 0 && task.current >= task.target).length;
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-wb2api-section-head",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
														className: "dsm-wb2api-section-title",
														children: account.accountName
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: "dsm-wb2api-section-sub",
														children: t("row.tasksSummary", {
															done,
															total: account.tasks.length
														})
													})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "dsm-btn dsm-btn-outline",
														disabled: tasksBusy,
														onClick: () => {
															runTasks(account.accountId);
														},
														children: tasksBusy ? t("row.tasksRunning") : t("row.tasksRun")
													})]
												}),
												account.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													className: "dsm-wb2api-error",
													children: account.error
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: "dsm-wb2api-task-list",
													children: account.tasks.map((task) => {
														const settled = task.claimed || task.target > 0 && task.current >= task.target;
														const result = resultsByCode.get(task.taskCode);
														return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: `dsm-wb2api-task${settled ? " dsm-wb2api-task-done" : ""}`,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																	className: "dsm-wb2api-task-head",
																	children: [
																		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: "dsm-wb2api-task-title",
																			children: task.title
																		}),
																		task.claimed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: "dsm-wb2api-badge dsm-wb2api-badge-ready",
																			children: t("row.tasksClaimed")
																		}) : task.claimable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: "dsm-wb2api-badge dsm-wb2api-badge-cooldown",
																			children: t("row.tasksClaimable")
																		}) : null,
																		task.automated ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: "dsm-wb2api-badge dsm-wb2api-badge-disabled",
																			title: t("row.tasksUnsupportedWhy", { reason: task.unsupportedReason ?? "" }),
																			children: t("row.tasksUnsupported")
																		}),
																		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsm-wb2api-task-spacer" }),
																		task.target > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: "dsm-wb2api-task-progress",
																			children: [
																				task.current,
																				"/",
																				task.target
																			]
																		}) : null,
																		task.credit > 0 || task.energy > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: "dsm-wb2api-task-reward",
																			children: task.energy > 0 ? t("row.tasksRewardEnergy", {
																				credit: task.credit,
																				energy: task.energy
																			}) : t("row.tasksReward", { credit: task.credit })
																		}) : null
																	]
																}),
																task.detail === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
																	className: "dsm-wb2api-task-detail",
																	children: task.detail
																}),
																result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
																	className: `dsm-wb2api-task-report${result.outcome === "error" ? " dsm-wb2api-task-report-error" : ""}`,
																	children: result.progressAfter === void 0 ? result.message : `${result.progressBefore ?? "?"} → ${result.progressAfter} · ${result.message}`
																})
															]
														}, task.taskCode);
													})
												})
											] }, account.accountId);
										})
									}),
									schedule === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-wb2api-task-schedule",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
												className: "dsm-wb2api-task-schedule-title",
												children: t("row.tasksAuto")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.tasksAutoEnabled") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: schedule.enabled,
												disabled: !writable,
												onChange: (event) => {
													saveSchedule({
														...schedule,
														enabled: event.currentTarget.checked
													});
												}
											})] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.tasksAutoAt") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "number",
													min: 0,
													max: 23,
													value: schedule.hour,
													disabled: !writable,
													onChange: (event) => {
														const raw = event.currentTarget.value;
														if (raw.trim() === "") return;
														const hour = Number(raw);
														if (Number.isFinite(hour)) saveSchedule({
															...schedule,
															hour
														});
													}
												}),
												" : ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "number",
													min: 0,
													max: 59,
													value: schedule.minute,
													disabled: !writable,
													onChange: (event) => {
														const raw = event.currentTarget.value;
														if (raw.trim() === "") return;
														const minute = Number(raw);
														if (Number.isFinite(minute)) saveSchedule({
															...schedule,
															minute
														});
													}
												})
											] })] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.tasksAutoOnStart") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: schedule.runOnStart,
												disabled: !writable,
												onChange: (event) => {
													saveSchedule({
														...schedule,
														runOnStart: event.currentTarget.checked
													});
												}
											})] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
												className: "dsm-wb2api-task-schedule-note",
												children: [
													schedule.running ? t("row.tasksAutoRunning") + " · " : "",
													schedule.nextRunAtMs === void 0 ? "" : t("row.tasksAutoNext", { at: formatDateTime(schedule.nextRunAtMs) }) + " · ",
													schedule.lastRunAtMs === void 0 ? t("row.tasksAutoLast", { at: t("row.tasksAutoNever") }) : t("row.tasksAutoLast", { at: formatDateTime(schedule.lastRunAtMs) })
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsm-wb2api-task-schedule-note",
												children: schedule.lastSkipped.map((entry) => t("row.tasksSkipped", {
													name: entry.accountName,
													reason: entry.reason
												})).join(" · ")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dsm-wb2api-actions-buttons",
												style: { gridColumn: "1/-1" },
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: tasksBusy,
													onClick: () => {
														runTasks();
													},
													children: t("row.tasksAutoRunNow")
												})
											})
										]
									})
								]
							}),
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
										onClick: discard,
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
		//#region src/client/scope.ts
		/**
		* Build a scope over the configuration route.
		*
		* Never throws: a host that cannot answer leaves the card in its read-only state,
		* which is strictly better than the card failing to render at all.
		*/
		function createRouteSettingsScope(options) {
			const doFetch = options.fetch ?? globalThis.fetch;
			let snapshot = {
				status: "loading",
				writable: false
			};
			const listeners = /* @__PURE__ */ new Set();
			const emit = () => {
				for (const listener of [...listeners]) try {
					listener();
				} catch {}
			};
			/** Read the document and publish it. Returns the published snapshot. */
			const refresh = async () => {
				try {
					const response = await doFetch(options.url, {
						method: "GET",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const body = await response.json();
					snapshot = {
						status: "ready",
						...body?.value === void 0 ? {} : { value: body.value },
						writable: body?.writable === true
					};
				} catch {
					snapshot = {
						status: "error",
						writable: false
					};
				}
				emit();
				return snapshot;
			};
			refresh();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				async set(field, value) {
					const response = await doFetch(options.url, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({
							field,
							value
						})
					});
					if (!response.ok) {
						const body = await response.json().catch(() => void 0);
						throw new Error(body?.error ?? `HTTP ${response.status}`);
					}
					await refresh();
				}
			};
		}
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
			"row.title": "WorkBuddy account pools (dsh-workbuddy2api)",
			"row.desc": "Two independent account pools — domestic and international — each with weighted rotation, session stickiness, cooldown/breaker health, and its own model directory.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.tabCn": "Domestic",
			"row.tabGlobal": "International",
			"row.tabHint": "These are two separate providers with separate pools and separate model directories. Models are listed per provider, so a model that both gateways carry keeps its own credit rate on each side.",
			"row.providerLabel": "Provider {provider}",
			"row.empty": "No WorkBuddy sign-in found",
			"row.emptyHint": "Sign in with the button above, or sign in once in the WorkBuddy desktop app and press “Detect accounts again”.",
			"row.requestFailed": "Request failed",
			"row.signIn": "Sign in with a browser",
			"row.signInStarting": "Opening the sign-in page…",
			"row.signInWaiting": "Waiting for the browser sign-in…",
			"row.signInOpen": "Open the sign-in page again",
			"row.signInCancel": "Cancel sign-in",
			"row.signInDone": "Added {account}",
			"row.signInHint": "Opens the official WorkBuddy sign-in page. This adds the account to the {region} pool only — the desktop app is not touched.",
			"row.signInBlocked": "The browser blocked the sign-in page; press “Open the sign-in page again”.",
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
			"row.accountModelCooldowns": "Model limits",
			"row.accountModelCooldown": "{model} until {at}",
			"row.accountModelCooldownHint": "These models are refused for this account only; it keeps serving the others.",
			"row.accountReset": "Recover",
			"row.accountCredits": "Credits {credits}",
			"row.accountCreditsExpiring": "{credits} ({soon} expiring soon)",
			"row.accountCreditsUnknown": "Credits unknown",
			"row.accountExpires": "Token expires {at}",
			"row.refreshCredits": "Refresh credits",
			"row.refreshingCredits": "Refreshing credits…",
			"row.creditsError": "Credit query failed: {message}",
			"card.pageTitle": "WorkBuddy accounts",
			"row.checkinClaim": "Check in",
			"row.checkinClaiming": "Checking in…",
			"row.checkinClaimed": "Checked in",
			"row.checkinError": "Check-in unavailable: {message}",
			"row.taskRunAccount": "Do tasks",
			"row.taskRunAccountBusy": "Doing tasks…",
			"row.creditsRatio": "{percent}% of the granted allowance left",
			"row.creditsRatioUnknown": "Remaining share unknown",
			"row.creditsTotal": "{credits} / {capacity} credits left · {percent}%",
			"row.creditsTotalNoRatio": "{credits} credits left",
			"row.creditsTotalUnknown": "Credits not queried yet — press “Refresh credits”.",
			"row.creditsTotalPartial": "{count} account(s) not queried yet",
			"row.creditsTotalAccounts": "across {count} account(s)",
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
			"row.tasksTitle": "Growth tasks",
			"row.tasksHint": "The gateway pays for observed behaviour, so finishing a task means reporting what it is scored on. Tasks that need the official client are listed but never attempted.",
			"row.tasksRefresh": "Refresh tasks",
			"row.tasksRefreshing": "Refreshing tasks…",
			"row.tasksRun": "Finish automatable tasks",
			"row.tasksRunning": "Finishing tasks…",
			"row.tasksSummary": "{done}/{total} done",
			"row.tasksClaimableCount": "{count} ready to claim",
			"row.tasksHintCollapsed": "Collapsed — expand to see every task and its progress.",
			"row.tasksAutoAtShort": "auto daily at {at}",
			"row.tasksAutoOff": "auto sweep off",
			"row.tasksUnsupported": "Needs the client",
			"row.tasksUnsupportedWhy": "Needs the official client: {reason}",
			"row.tasksClaimable": "Ready to claim",
			"row.tasksClaimed": "Reward taken",
			"row.tasksReward": "+{credit} credits",
			"row.tasksRewardEnergy": "+{credit} credits, +{energy} energy",
			"row.tasksAuto": "Automatic sweep",
			"row.tasksAutoEnabled": "Run every day",
			"row.tasksAutoAt": "Daily at",
			"row.tasksAutoOnStart": "Also run once after DSH starts",
			"row.tasksAutoNext": "Next run {at}",
			"row.tasksAutoLast": "Last run {at}",
			"row.tasksAutoNever": "not yet run",
			"row.tasksAutoRunning": "A sweep is running…",
			"row.tasksAutoRunNow": "Run a sweep now",
			"row.tasksSkipped": "Skipped {name}: {reason}",
			"row.tasksEmpty": "No tasks found for this account.",
			"row.tasksIntl": "The international gateway has no growth-task system, so its accounts are never swept.",
			"row.tasksResultDone": "done",
			"row.tasksResultSkipped": "skipped",
			"row.tasksResultError": "failed",
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
			"row.desc": "国内版与国际版是两个独立账号池，各有加权轮换、会话粘性、冷却/熔断健康度，以及自己那份模型目录。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.tabCn": "国内版",
			"row.tabGlobal": "国际版",
			"row.tabHint": "这是两个独立供应商：账号池、模型目录都分开。模型按供应商分别列出，因此两个网关都有的模型各自保留自己的积分倍率。",
			"row.providerLabel": "供应商 {provider}",
			"row.empty": "没有检测到 WorkBuddy 登录",
			"row.emptyHint": "点上面的「网页登录添加账号」，或先在 WorkBuddy 桌面 App 里登录一次再点「重新检测账号」。",
			"row.requestFailed": "请求失败",
			"row.signIn": "网页登录添加账号",
			"row.signInStarting": "正在打开登录页…",
			"row.signInWaiting": "等待浏览器完成登录…",
			"row.signInOpen": "重新打开登录页",
			"row.signInCancel": "取消登录",
			"row.signInDone": "已添加 {account}",
			"row.signInHint": "会打开 WorkBuddy 官方登录页。账号只会加进「{region}」这一侧的账号池，不会动桌面端。",
			"row.signInBlocked": "浏览器拦截了登录页，请点「重新打开登录页」。",
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
			"row.accountModelCooldowns": "模型级限额",
			"row.accountModelCooldown": "{model} 至 {at}",
			"row.accountModelCooldownHint": "这些模型只对这个账号不可用；它仍在服务其他模型。",
			"row.accountReset": "恢复",
			"row.accountCredits": "积分 {credits}",
			"row.accountCreditsExpiring": "{credits}（其中 {soon} 即将过期）",
			"row.accountCreditsUnknown": "积分未知",
			"row.accountExpires": "令牌 {at} 过期",
			"row.refreshCredits": "刷新积分",
			"row.refreshingCredits": "正在刷新积分…",
			"row.creditsError": "积分查询失败：{message}",
			"card.pageTitle": "WorkBuddy 账号池",
			"row.checkinClaim": "签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinClaimed": "今日已签到",
			"row.checkinError": "签到状态获取失败：{message}",
			"row.taskRunAccount": "做任务",
			"row.taskRunAccountBusy": "任务中…",
			"row.creditsRatio": "剩余 {percent}% 额度",
			"row.creditsRatioUnknown": "剩余额度未知",
			"row.creditsTotal": "本池剩余 {credits} / {capacity} 积分 · {percent}%",
			"row.creditsTotalNoRatio": "本池剩余 {credits} 积分",
			"row.creditsTotalUnknown": "本池积分尚未查询 —— 点「刷新积分」",
			"row.creditsTotalPartial": "另有 {count} 个账号未查询",
			"row.creditsTotalAccounts": "共 {count} 个账号",
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
			"row.tasksTitle": "成长任务",
			"row.tasksHint": "上游只按「观察到的行为」计分，所以完成一个任务 = 上报它考核的那个事件。需要官方客户端内操作的任务会列出来，但不会被尝试。",
			"row.tasksRefresh": "刷新任务",
			"row.tasksRefreshing": "正在刷新任务…",
			"row.tasksRun": "一键完成可自动任务",
			"row.tasksRunning": "正在完成…",
			"row.tasksSummary": "已完成 {done}/{total}",
			"row.tasksClaimableCount": "{count} 个可领取",
			"row.tasksHintCollapsed": "已折叠 —— 展开可看每个任务及其进度。",
			"row.tasksAutoAtShort": "自动执行 每天 {at}",
			"row.tasksAutoOff": "自动执行已关闭",
			"row.tasksUnsupported": "需客户端操作",
			"row.tasksUnsupportedWhy": "需官方客户端操作：{reason}",
			"row.tasksClaimable": "可领取",
			"row.tasksClaimed": "已领取",
			"row.tasksReward": "+{credit} 积分",
			"row.tasksRewardEnergy": "+{credit} 积分，+{energy} 能量",
			"row.tasksAuto": "自动执行",
			"row.tasksAutoEnabled": "每天自动执行",
			"row.tasksAutoAt": "执行时刻",
			"row.tasksAutoOnStart": "启动 DSH 后也执行一次",
			"row.tasksAutoNext": "下次执行 {at}",
			"row.tasksAutoLast": "上次执行 {at}",
			"row.tasksAutoNever": "尚未执行",
			"row.tasksAutoRunning": "正在执行一轮…",
			"row.tasksAutoRunNow": "立即执行一轮",
			"row.tasksSkipped": "已跳过 {name}：{reason}",
			"row.tasksEmpty": "该账号没有任务。",
			"row.tasksIntl": "国际版没有成长任务体系，其账号不会参与自动执行。",
			"row.tasksResultDone": "完成",
			"row.tasksResultSkipped": "跳过",
			"row.tasksResultError": "失败",
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
		/**
		* Client services this contribution needs.
		*
		* `settingsScope` is deliberately NOT required. DSH 0.1.7-rc.2 removed it, and a
		* required-but-absent service keeps the whole entry PENDING — which DSH reports
		* as a boot-level "Failed to load plugins / 1 entry did not activate" banner, not
		* as a merely missing card. The scope is resolved optionally below instead, and
		* the card already treats every read as possibly-absent.
		*/
		const inject = ["slots", "locale"];
		/**
		* The framework's own settings service, when this host still has one.
		*
		* Read through `ctx.get`, never as a plain property: a property read of a service
		* this entry did not inject THROWS in cordis, it does not return undefined — and
		* that throw happens before anything is registered, so the card silently vanishes.
		* The whole thing is guarded anyway, because "the host has no settings service" is
		* an ordinary state here (0.1.7+ removed it), not an error worth failing on.
		*/
		function legacySettingsScope(ctx) {
			try {
				const get = ctx.get;
				if (typeof get !== "function") return void 0;
				const service = get.call(ctx, "settingsScope");
				if (service === void 0 || typeof service.bind !== "function") return void 0;
				return service.bind({ namespace: "workbuddy2api" });
			} catch {
				return;
			}
		}
		/** Register card copy and the pool card under Plugin configuration. */
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy2api";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy2api: settings copy");
				const t = ctx.locale.bind(namespace);
				const settingsScope = legacySettingsScope(ctx) ?? createRouteSettingsScope({ url: "/plugins/dsh-workbuddy2api/config" });
				const injected = (extra = {}) => ({
					t,
					settingsScope,
					...extra
				});
				let mounted = false;
				const registerSection = () => ctx.slots.register({
					name: "settings.section",
					id: "workbuddy2api",
					order: 60,
					label: () => t("card.pageTitle"),
					locale: namespace,
					inject: () => injected({ page: true })
				}, WorkBuddyPoolCard);
				const registerItem = () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy2api",
					priority: 30,
					inject: injected
				}, WorkBuddyPoolCard);
				const mountInto = (key) => {
					if (mounted) return () => {};
					mounted = true;
					console.info("[dsh-workbuddy2api] settings card mounted into " + key);
					return key === "settings.section" ? registerSection() : registerItem();
				};
				ctx.slots.inject("settings.section", () => mountInto("settings.section"));
				ctx.slots.inject("settings.plugin.item", () => {
					const timer = setTimeout(() => {
						mountInto("settings.plugin.item");
					}, 500);
					return () => {
						clearTimeout(timer);
					};
				});
				setTimeout(() => {
					if (mounted) return;
					console.warn("[dsh-workbuddy2api] settings card could not mount: no settings slot was declared");
				}, 5e3);
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
