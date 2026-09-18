/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT）— 版本由构建期 define 注入，
 *   而非运行时读 package.json（发布包只含 lib/）。
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 同样的 define 注入形态，本插件沿用。
 * 改动：常量名改为本插件的 `WORKBUDDY2API_VERSION`。
 *
 * @module dsh-workbuddy2api/version
 */

declare const __DSH_WORKBUDDY2API_VERSION__: string

/** The npm package version this build was produced from. */
export const WORKBUDDY2API_VERSION: string =
  typeof __DSH_WORKBUDDY2API_VERSION__ === 'string' && __DSH_WORKBUDDY2API_VERSION__ !== ''
    ? __DSH_WORKBUDDY2API_VERSION__
    : '0.0.0-dev'
