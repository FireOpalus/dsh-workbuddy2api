//#region src/bin.d.ts
/**
 * Standalone status/diagnostics CLI for the dsh-workbuddy2api bundle.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段、以及「宿主心跳 + 桌面端凭据
 *     文件 + 登录态」三项联合诊断的结构，均由该项目沿用自
 *     corrinehu/dsh-workbuddy-connect（MIT）。
 * 改动：诊断对象从「每个区域一个账号」改为「账号池」，`status` 报告每个
 *   账号的健康、冷却与余额；新增 `pool` 子命令直接打印池快照（含权重、
 *   在途、连续失败、冷却截止），无需浏览器即可确认多账号调度状态。
 *
 * @module dsh-workbuddy2api/bin
 */
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };