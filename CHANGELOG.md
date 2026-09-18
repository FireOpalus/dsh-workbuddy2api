# 更新日志

## [0.1.1] - 2026-09-18

### 修复

- **从 git 安装不再需要 allowBuilds。** 0.1.0 把 `lib/` 排除在仓库之外，
  而 pnpm 对 git 依赖的判定是「有 prepack 且仓库里没有 main 文件 → 需要跑构建
  脚本」，于是每个用 `dsh plugin add git+https://…` 的人都会撞上
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。现在把构建产物 `lib/` 提交进仓库，
  pnpm 判定「不需要构建」，开箱即装。`prepack` 保留，`npm pack` / `npm publish`
  照旧先构建。
- 发布工作流新增一道闸：构建后断言 `git diff --exit-code lib/`，
  防止提交的构建产物与 `src` 脱节（那会让用户装到旧代码）。该断言只比内容、
  不比文件模式——`tsdown` 在 Linux 上会给 `lib/bin.js` 补可执行位，
  而 Windows 检出时没有这个位，一次 mode-only 差异会变成假警报。
  同时把 `lib/bin.js` 在索引里的模式记成 `100755`，与构建产物一致。

## [0.1.0] - 2026-09-18

首个版本：把 workbuddy2api 的多账号调度带进 DeepSeek Harness。

### 新增

- **账号池**（`src/pool.ts`）：四维健康状态（禁用 / 冷却 / 熔断 / 降权）、
  加权随机选号（余额 ×10、快过期积分 ×8、闲置补偿 0.5/h 封顶 5）、
  Top5 短名单 + 防撞号 + LRU 兜底、按账号的并发上限
  （默认 3，国际版账号 2，整池 8）。
- **会话粘性**：同一会话（system + 首条 user 消息派生）固定同一账号，
  TTL 30 分钟滚动续期、GC 5 分钟。
- **失败迁移**：额度不足 → 次日 04:00 硬冷却；限流 → 600s 基数指数退避
  封顶 2h（已在冷却中不翻倍）；连续 3 次 5xx 熔断（30m 起翻倍封顶 6h）；
  无分类失败连败 5 次降权 10m。
- **换号重试**：额度不足 / 限流 / 会话失效 / 5xx 自动换一个账号重试
  （默认最多 3 次），客户端错误直接透传不重试。
- **多账号凭据**：扫描桌面端 auth 目录（含时间戳备份），按 `uin` 去重；
  每个账号一份独立的刷新副本 `$DSH_HOME/.workbuddy2api-auth.<id>.json`，
  N 个账号同时在线互不覆盖。
- **双区域账号共存**：国内版与国际版账号同池调度，模型目录取两边并集。
- **单 provider**：`workbuddy2api`，模型名内嵌积分倍率。
- **设置卡片**：账号列表（健康徽标、权重、启用开关、恢复、积分、签到）、
  池策略表单、模型管理（刷新 → 勾选 → 保存）、按需刷新积分。
- **同源路由**：`usage` / `accounts/refresh` / `credits/refresh` /
  `models/refresh` / `checkin` / `pool`。
- **CLI**：`doctor` / `status` / `pool` / `logout`，均支持 `--json`。
- **隔离测试环境**：`testenv/setup.mjs` + `testenv/run.cmd`，把
  `DSH_HOME` 指向工作区内，在 127.0.0.1:63950 起一个独立 web profile。