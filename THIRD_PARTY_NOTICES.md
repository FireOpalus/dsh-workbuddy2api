# 第三方开源声明 / Third-Party Notices

本插件（`dsh-workbuddy2api`）的实现建立在下列已公开项目之上。所有参考项均为
**借鉴设计思路 + 独立实现**：本仓库不包含任何参考项目的源码副本，关键模块
均为独立编写，并在源文件头部注释中标注了所参考的具体项目、借鉴的内容与本
项目的改动。

## 一、账号池与调度语义

### Sliverkiss/workbuddy2api（MIT）

- 仓库：<https://github.com/Sliverkiss/workbuddy2api>
- 参考范围：本机同级目录 `D:\Project\workbuddy2api` 的 Go 实现。
- 借鉴内容（本插件 `src/pool.ts` 的设计依据）：
  - 四维正交状态机（禁用 / 冷却 / 熔断 / 降权）与 `healthy()` 或门；
  - 选号流程：候选过滤 → 全冷却兜底 → 权重计算 → Top5 截断 →
    防撞号（`minPickGap`）→ 加权随机，全撞号时按单调序号 LRU 兜底；
  - 权重三因子：余额占比 ×10、快过期积分占比 ×8、闲置补偿 0.5/h 封顶 5；
  - 失败分类迁移：额度不足 → 次日 04:00 硬冷却；限流 → 600s 基数、
    指数退避封顶 2h，且「已在软冷却中不推进不延长」；连续失败达 3 次熔断
    （30m 起、翻倍封顶 6h）；无分类失败连败 5 次降权 10m；
  - 会话粘性：按会话键绑定账号、TTL 30m 滚动续期、GC 5m；
  - 上游协议：`copilot.tencent.com` 的 wire behavior（强制流式、
    `tool_choice` 压平、CLI 形态请求头、错误分类词表）。
- 改动：本插件只保留单进程 Node 下有意义的部分（无 Redis 快照镜像、
  无 realm 分池快照、无签到/旅行/夜猫子等额度增益排程），并把
  「按模型冷却」并入账号级降权（本插件的模型目录是多账号合并的）。

## 二、DSH 插件内核与呈现

### dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）

- 仓库：<https://github.com/dingminhua/dsh-connect-workbuddy>
- 参考范围：本机已安装的 npm 包 `dsh-connect-workbuddy@2.0.3` 及其
  公开源码。
- 借鉴内容：
  - `src/auth.ts`：桌面端 auth 文件只读、刷新结果写入 `$DSH_HOME` 自有副本、
    按 `uin` 去重的目录扫描、`live 文件 > lastRefreshTime > expiresAt`
    三级择新、按需刷新与单飞去重、平台路径候选（macOS / Windows
    Local+Roaming / Linux XDG）；
  - `src/upstream.ts`：模型目录的两种文档形态（CN 的
    `/v2/enterprises/personal/models` 与国际版的 `/v3/config`）、
    积分套餐的月度/一次性判定、`credits`/`reasoning` 字段解析；
  - `src/shim.ts`：入站加固的四重校验（Host / Origin / Content-Type /
    bearer）、常量时间比对、随机端口、body 上限；
  - `src/adapter.ts`：pi-ai provider 的装配方式（`createProvider` +
    `openAICompletionsApi` + inert auth plane + shim 的进程内 secret）；
  - `src/index.ts`：宿主装配顺序、`installSettingsSection` 的用法、
    webServer 为可选服务的处理、`lastCatalog` 与 `enabledModelIds` 分离；
  - `src/web-status.ts` 与 `src/client/*`：同源只读路由形态、回环来源校验、
    `safeMessage` 脱敏、卡片结构、`dsm-*` 样式系统、`row.*` 双语文案约定；
  - `src/bin.ts` 与 `src/host-heartbeat.ts`：`status`/`doctor`/`logout` 诊断
    与宿主心跳文件。
- 改动：单 provider + 账号池（原实现是「每区域一个 provider、一个账号」）；
  每个账号一份独立的 token 副本（原实现每区域一份）；卡片改为账号池视图
  并新增池策略表单。

### corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）

- 仓库：<https://github.com/corrinehu/dsh-workbuddy-connect>
- 参考范围：**经 dingminhua/dsh-connect-workbuddy 转引**。
- 借鉴内容：WorkBuddy 接入 DSH 的原始可行方案 —— 桌面端凭据发现与刷新、
  loopback shim 的入站加固、pi-ai provider 装配、status 路由与诊断 CLI、
  宿主心跳机制。
- 说明：本项目未直接阅读该项目源码，其内容经上述转引项目传递；
  许可证义务按 MIT 要求保留版权与许可声明。

### dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）

- 仓库：<https://github.com/dingminhua/dsh-connect-trae>
- 参考范围：**经 dingminhua/dsh-connect-workbuddy 转引**。
- 借鉴内容：`lastCatalog` + 勾选模型的管理模型、`dsm-*` 卡片样式体系、
  `settingsScope` 配置回写、`row.*` 双语文案键约定。

### dingminhua/dsh-subagent-default-model（MIT，Copyright (c) 2026 LaoDing）

- 参考范围：**经 dsh-connect-trae / dsh-connect-workbuddy 转引**。
- 借鉴内容：`dsm-*` 样式与折叠卡片外壳的原始来源。

### franksong2702/dsh-codex-connect（Apache-2.0）

- 参考范围：**经 corrinehu/dsh-workbuddy-connect 转引**。
- 借鉴内容：DSH 插件结构与 provider 注册的整体思路。
- Apache-2.0 义务履行：本插件**未复制该项目源码**（亦未直接阅读），
  仅在架构层面受其启发；如该项目在分发时附带 `NOTICE` 文件，本插件
  未随附该 `NOTICE`，因为未使用其任何受版权保护的材料。

### DSHboost（同机项目，仅参考测试环境做法）

- 位置：`D:\Project\DSHboost\testenv`
- 借鉴内容：`testenv/` 隔离测试环境的三条做法 —— 把 `DSH_HOME` 指向
  工作区内的目录、使用独立 profile、使用不冲突的端口。
- 说明：未复制其源码。

## 三、运行时依赖

本插件不捆绑任何第三方运行时依赖；下列包以 peer dependency 形式由宿主提供：

| 包 | 许可证 |
|---|---|
| `@deepseek-ai/cordis` | MIT |
| `@deepseek-ai/dsh-*`（宿主提供的 DSH 服务包） | MIT |
| `@deepseek-ai/schemastery` | MIT |
| `@earendil-works/pi-ai` | MIT |
| `react` | MIT |

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在
  本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果
  （包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联，未获其授权或
  认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。
- 本项目的作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
