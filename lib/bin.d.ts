//#region src/bin.d.ts
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
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };