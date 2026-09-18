/**
 * Card icon: an inline SVG data URI, so the bundle ships no binary asset and
 * the card renders identically in every host.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「图标内联为 data URI 常量」的做法来自该项目（其图标来自
 *     dsh-subagent-default-model 的 LD 品牌体系）。
 * 改动：绘制本插件自己的图形（三个节点汇聚成一条流向），
 *   寓意「多账号汇入一个 provider」。
 *
 * @module dsh-workbuddy2api/client/icon
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#1f6feb"/>
  <circle cx="9" cy="8" r="2.6" fill="#ffffff" opacity="0.95"/>
  <circle cx="9" cy="16" r="2.6" fill="#ffffff" opacity="0.75"/>
  <circle cx="9" cy="24" r="2.6" fill="#ffffff" opacity="0.55"/>
  <path d="M11.6 8 H17 a3 3 0 0 1 3 3 V14" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <path d="M11.6 16 H18.4" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <path d="M11.6 24 H17 a3 3 0 0 0 3 -3 V18" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.9"/>
  <rect x="20.5" y="13.5" width="6" height="5" rx="1.6" fill="#ffffff"/>
</svg>`

/** Data-URI form of the card icon. */
export const WORKBUDDY2API_PLUGIN_ICON = `data:image/svg+xml,${encodeURIComponent(SVG)}`
