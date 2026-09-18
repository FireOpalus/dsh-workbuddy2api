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

export const WORKBUDDY2API_CARD_CSS = `
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
.dsm-wb2api-task-schedule label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}
.dsm-wb2api-task-schedule input[type=number]{width:64px;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-wb2api-task-schedule input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-wb2api-task-schedule-note{grid-column:1/-1;margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-wb2api-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-wb2api-save-error{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:16px;text-align:right}
.dsm-wb2api-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
@media (max-width:760px){.dsm-wb2api-policy{grid-template-columns:1fr}}
`