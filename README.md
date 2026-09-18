# dsh-workbuddy2api

把**本机已登录的多个 WorkBuddy 账号**接进 DeepSeek Harness，并用
[workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 那套账号池语义在它们之间调度：
加权轮换、会话粘性、冷却 / 熔断 / 降权健康度、换号重试。

**两个 provider、两个账号池、两份模型目录** —— `workbuddy2api`（国内版账号）
与 `workbuddy2api-global`（国际版账号）互不相通，各自轮换、各自计费。

## 为什么需要它

`dsh-connect-workbuddy` 一次只服务**一个**账号（每区域一个），
账号切换是显式的、需要用户手动选。当你有多个 WorkBuddy 账号时：

- 一个账号额度用完，整个 provider 就报错；
- 想同时用国内版和国际版的模型，得来回切账号；
- 没有并发上限，容易触发上游限流；
- 额度分布看不见，不知道哪个账号还有余额。

本插件把这些问题交给账号池：**多个账号同时在线，自动挑最该用的那个，
坏掉的自动冷却，请求自动换号重试。**

## 功能特性

- **账号池调度** —— 每个账号带四个正交状态（启用 / 冷却 / 熔断 / 降权），
  选号 = 健康过滤 → 加权随机 → 防撞号 → LRU 兜底。
- **权重三因子** —— 余额占比 ×10、**快过期积分占比 ×8**（积分要过期了先用掉）、
  闲置补偿 0.5/小时封顶 5（久未使用的账号更可能被选中）。
- **会话粘性** —— 同一会话固定同一账号（TTL 30 分钟滚动续期），
  不同会话自动分散到不同账号；粘住的账号失效时才重新分配。
- **失败分类迁移** —— 额度不足 → 次日 04:00 硬冷却；限流 → 600s 基数、
  指数退避封顶 2h，且**已在冷却中不翻倍**（避免用户狂点重试把冷却越堆越厚）；
  连续 3 次 5xx 熔断（30m 起翻倍封顶 6h）；无分类失败连败 5 次降权 10 分钟。
- **换号重试** —— 额度不足 / 限流 / 会话失效 / 5xx 自动换一个账号重试
  （默认最多 3 次）；客户端错误（参数写错、内容被拦）直接透传，不浪费别的账号。
- **并发上限** —— 单账号默认 3、国际版账号 2、整池 8，全可调。
- **网页登录添加账号** —— 卡片里点「网页登录添加账号」即打开 WorkBuddy 官方
  登录页，完成登录后凭据自动落进**该 tab 那一侧**的账号池，免重启、免桌面端。
  与「扫描桌面端 auth 目录」并存：两条路径发现的同一个账号会自动合并成一条池记录。
- **多账号凭据** —— 扫描 WorkBuddy 桌面端 auth 目录（含带时间戳的历史备份），
  按 `uin` 去重；**每个账号一份独立的刷新副本**，N 个账号同时在线互不覆盖。
  桌面端文件永远只读。
- **按账号积分、剩余额度环与签到** —— 卡片里逐个账号显示剩余积分、
  即将过期额度、一个表示「当前积分 ÷ 已发放总额度」的小环，以及一键签到
  （就在环的右边）。**版本 tab 下方另有一行本池合计**
  （`本池剩余 4 371 / 4 468 积分 · 98% · 共 1 个账号`）配同样颜色的环，
  切 tab 后一眼就知道整池还剩多少。算不出比值时只画灰环并标注「剩余额度未知」，
  不会编一个百分比；**没查过的账号单独报「另有 N 个未查询」，不当成 0**。
  积分按需刷新，不随卡片轮询打上游。
- **自动成长任务（17 个动作，与参考实现 workbuddy2api 对齐）** ——
  卡片列出该账号在上游的全部任务（进度 / 奖励 / 可领取），并把可自动化的任务
  一键做完：报名 → 上报行为事件 → 等上游异步计分 → 达标自动领奖。
  默认**每天 00:05** 跑一轮，并在 **DSH 启动约 20 秒后**再跑一轮，
  两处都能在卡片里改。其中 7 个需要**真实对话**（专家召唤+使用、`skill_info`、
  指定模型对话、夜猫子），真实对话由插件自己发，事件的 `requestId` 用
  **服务端返回的那个**；只有「需要真实付款」与「需要打扰第三方」的两个不做。
- **两个独立账号池** —— 国内版（`copilot.tencent.com`，provider `workbuddy2api`）
  与国际版（`workbuddy.ai` / `codebuddy.ai`，provider `workbuddy2api-global`）
  各有自己的账号、健康、权重、策略与模型目录。**为什么必须分开**：上游对同一个
  model id 在两个区域给出不同语义 —— `deepseek-v4.1-flash` 在国际版是 x0.00 的
  免费促销模型，在国内版是 x0.03 的收费模型。合并目录会让一边的倍率覆盖另一边的，
  而且请求按 id 路由时落到哪个账号取决于池子的选号结果，**显示的倍率会与实际扣费
  不一致**。分开之后，选中的 provider 就是倍率与路由的唯一依据。
- **安全 loopback shim** —— 随机端口 + 进程内随机 secret，
  四重入站校验（Host / Origin / Content-Type / bearer），真实 token 不交给 pi-ai。
- **CLI 诊断** —— `doctor` / `status` / `pool` / `logout`，支持 `--json`。

## 工作原理

```text
DSH 模型选择器
  ├─ provider workbuddy2api（国内版）
  │    -> PiAiAdapter -> 安全 loopback shim（随机端口 + 进程内 secret）
  │    -> 国内账号池 pick()：会话粘性 → 健康过滤 → 加权随机
  │    -> 账号 A/B/… 的凭据（各自独立，按需刷新）
  │    -> https://copilot.tencent.com/v2/chat/completions
  └─ provider workbuddy2api-global（国际版）
       -> 同样的四层，但账号池、目录、shim 完全独立
       -> https://www.workbuddy.ai/v2/chat/completions（或 codebuddy.ai）

  两者共用：凭据发现（按区域过滤）、上游客户端、错误分类与健康迁移规则。
  结果回报给所属池；失败且可重试时在该池内换一个账号再来一次。

  添加账号（卡片「网页登录添加账号」，按 tab 决定 realm）
    -> POST {base}/v2/plugin/auth/state?platform=CLI  取 state + authUrl
    -> 浏览器完成登录，卡片每 3s GET {base}/v2/plugin/auth/token?state=…
    -> 完成时 GET {base}/v2/plugin/login/account?state=…（Bearer）取 uid/nickname
    -> 写入该区域的 .workbuddy2api-auth.<accountId>.json，并热加载进该区域的池
```

**账号池不持有 token**：池只决定「这一次用哪个账号 id」，
shim 再拿这个 id 去凭据库解析 token。这样 token 永远不进入调度层，
选号逻辑也能在注入时钟与随机数下完全确定地测试。

### 选号顺序

1. **会话粘性**优先 —— 会话绑定的账号只要健康就直接用它；
2. 否则过滤出**健康**的账号（存在、启用、不在冷却/熔断/降权、未达并发上限、
   且本次请求还没试过）；
3. 全部不健康时**兜底**：挑冷却最早结束的那个账号（**硬冷却除外** ——
   额度耗尽的账号重试只是浪费一次请求）；
4. 按权重排序：权重值 → 余额因子 → 闲置因子 → 用户优先级 → 最近最少使用；
5. 取前 5 名，剔除**100ms 内刚用过**的（防并发撞号），
   剩下的加权随机抽一个；前 5 名全被剔除时，在**全候选集**里取最近最少使用的
   （只在短名单里轮转会饿死权重靠后的账号）。

### 状态迁移

| 上游结果 | 迁移 |
|---|---|
| 成功 | 清零所有计数，滚动续期会话绑定 |
| 额度不足（402 / 余额关键词） | 硬冷却至**次日 04:00** |
| 会话失效（12153 / Offline user session not found） | 硬冷却至次日 04:00，提示重新登录 |
| 限流（429） | 软冷却，600s 基数按次数翻倍，封顶 2h；**已在冷却中不延长** |
| 404 | 软冷却 60s（固定，不参与退避） |
| 5xx | 熔断器：连续 3 次触发，30m 起翻倍，封顶 6h |
| 传输错误 / 其他 4xx | 连败 5 次降权 10 分钟、封顶 2h（**不冷却**：不知道原因，不该罚停账号；降权期内再次达阈不延长） |

### 自动任务怎么跑

```text
触发：每天 00:05（可改）        +  DSH 启动约 20 秒后（可关）
        └──────────────┬───────────────┘
                       v
        一轮 = 逐账号串行（账号间 3 秒间隔）
                       |
        1. GET  /v2/activity/growth/tasks          读任务与进度
        2. POST /v2/activity/growth/tasks/accept   尚未报名的批量报名
                       |
        3. 对每个「可自动化且未完成」的任务：
             a. 幂等跳过判定（已领取 / 已达标 → 不发任何请求）
             b. 上报该任务考核的行为事件
                · CLI/计费域 /v2/report        对话活跃事件
                · 桌面指纹  /v2/report         完整对话链 / buddyapp / 模板 / 画布 …
                · Web 指纹  {webBase}/v2/report 资料库点击等页面行为
             c. 有界回读（最多 4 次 × 3 秒）等上游异步计分
             d. 达标 → POST {webBase}/activity/growth/tasks/<code>/claim 领奖
```

**为什么必须「上报行为」**：`tasks/accept` 只是报名，**不产生任何进度**；
进度由服务端收到行为事件后**异步**点亮（实测上报后要数秒才刷新），
所以一次性的「查一下再领」会误判成未达标、从而跳过领奖。

**动作表（17 个，对齐参考实现 workbuddy2api）**

| 类别 | 动作 | 判据 |
|---|---|---|
| 事件上报 | `chat_5` `RichMeow_Chat` `Buddy_App` `Buddy_App_QQ` `automation_1` `Library_read` `template_5` `playbook_prompt` `create_canvas` `Hp_Appearance` | 桌面 / Web 指纹事件链 |
| 真实对话 | `Model_chat_GLM5.2` `skill_1` `black_cat` | 真发一次对话，事件 JOIN **服务端 requestId** |
| 专家链 | `expert_5` `Expert_team_use_3` `Expert_lighthouse` | 市场**真实**专家 id → 召唤链 → 带 `X-Expert-Id` 对话 → `expert_actual_use` |
| 领养 | `first_buddy` | 活跃上报 → 协议 → `buddy/first` |

**为什么必须用服务端的 requestId**：专家 / 技能类事件的 `requestId` 要 JOIN 一次
真实会话。自己编一个 UUID，`/v2/report` 会**收下并返回 200**，然后**永远不计分**
—— 这是最难查的一类失败。所以插件边收 SSE 边取服务端 id，取到就放弃剩余正文
（有界，不会被长回答拖住）。

**只有两个任务不做**，且原因不是「技术上做不到」：
`Expert_Philanthropy`（需要**真实捐款**，涉及真实支付）与
`share_invite`（需要把邀请链接**分享给他人**）。卡片会列出它们并说明原因。

**说「跳过」就不说「完成」**：`black_cat` 只认 23:00–08:00 窗口，窗口外如实报
`skipped` 并说明，而不是记一条假的完成记录。

## 安装

前置：无需任何 WorkBuddy 客户端 —— 在插件卡片里用「网页登录添加账号」即可
（已登录桌面 App 的账号也会被自动发现，两条路径可以混用）。

```sh
# 从工作区目录安装（开发期）
dsh plugin --profile web add D:/Project/dsh-wb2api

# 或从 npm 安装（发布后）
dsh plugin --profile web add dsh-workbuddy2api
```

安装、更新或卸载后需要重启对应的 DSH 进程。

## 命令行

```sh
dsh plugin --profile web exec dsh-workbuddy2api doctor   # 凭据路径、发现到的账号、宿主心跳
dsh plugin --profile web exec dsh-workbuddy2api status   # 每个账号的健康、冷却与剩余积分
dsh plugin --profile web exec dsh-workbuddy2api pool     # 池快照：权重、在途、连败、冷却截止
dsh plugin --profile web exec dsh-workbuddy2api logout   # 清除插件自有的凭据副本
```

`doctor` / `status` / `pool` 支持 `--json`。

## 设置卡片

在 **设置 → 插件配置** 里找到「WorkBuddy 账号池」：

- **网页登录添加账号**：点按钮 → 浏览器打开官方登录页 → 登录 → 卡片自动轮询并在
  完成时把账号加进当前 tab 的池（顺带拉一次积分与模型目录、补一次签到）。
  一次登录只可能落进发起它的那一侧，登录态存在浏览器 localStorage，
  中途刷新页面也不会丢；凭据只写插件自有的
  `$DSH_HOME/.workbuddy2api-auth.<accountId>.json`，**不碰桌面端文件**。
- **成长任务**：只有那份**长清单**可折叠（标题行即开关，**默认折叠** ——
  一个账号就有 18 个任务，多账号时不折叠会把下面的策略与模型挤出屏幕）。
  折叠时标题行给汇总（`已完成 16/18 · 1 个可领取`）与自动执行状态，
  右侧「刷新任务 / 一键完成可自动任务」两个按钮始终可见。
  **自动执行设置不参与折叠**，永远可见：开关「每天执行」、执行时刻、
  「启动后也执行一次」、下次 / 上次执行时间、上一轮逐项结果与跳过的账号。
  展开清单后列出每个任务的进度、奖励与可领取状态；账号那一行的「做任务」
  只跑该账号。
- **池内账号**：每个账号一行 —— 健康徽标、区域、启用开关、权重、恢复按钮、
  在途 / 成功 / 失败计数、冷却与熔断截止、最近错误、剩余积分、额度环、签到。
- **池策略**：在途上限、熔断阈值与时长、降权阈值与时长、限流冷却基数与上限、
  会话粘性 TTL、是否按余额排序。默认值即 workbuddy2api 的默认值。
- **模型**：从上游刷新目录 → 勾选启用 → 保存；图片输入按模型手动勾选
  （上游的能力标记不可靠，不作为依据）。刷新是草稿操作，点保存才生效。

## 发布（GitHub）

本插件的分发以 **GitHub 仓库 + Release** 为主：仓库即安装源
（`dsh plugin add https://github.com/FireOpalus/dsh-workbuddy2api`），
每个 tag 的 Release 附上 `npm pack` 出的 tarball 作为可归档产物。

### 打一个版本

```sh
# 1. 改 package.json 的 version，并在 CHANGELOG.md 里加一段 "## [x.y.z] - 日期"
# 2. 本地跑全套检查与产物自检
npm run check
npm run pack          # 产出 dist-pack/dsh-workbuddy2api-x.y.z.tgz
npm run verify-pack   # 12 项产物自检（清单/导出/客户端 bundle 是否齐全）
# 3. 提交并打标签
git add -A && git commit -m "chore(release): x.y.z"
git tag vx.y.z && git push origin main --tags
```

标签推上去后，`.github/workflows/release.yml` 会自动：校验标签与 package.json
版本一致 → 跑 typecheck 与全部单测 → `npm pack` 并做产物自检 → 用 CHANGELOG
里对应版本的段落建 Release 并附上 tarball。**版本不一致或测试不过，就不会产生
Release**，这是刻意的。

### 手动建 Release（可选）

工作流不可用（例如只想补发一个 tag）时，用仓库里的脚本：

```sh
WB2API_GH_TOKEN=<token> node scripts/publish-release.mjs v0.1.0
```

token 只从环境变量读、绝不打印；输出只有状态码与 URL；同名 asset 已存在时跳过。

### 为什么默认不发 npm

本插件是 DSH bundle，主要安装方式就是 git/本地目录，npm 只是可选渠道。
若之后要同时发 npm，参照同机 `dsh-laa` 的
`.github/workflows/publish.yml`（npm trusted publishing / OIDC），注意三个坑：
不要给 `setup-node` 传 `registry-url`、发布前 `unset NODE_AUTH_TOKEN`（空串也会
让 npm 先走 token 认证并报 `ENEEDAUTH`）、npm 必须 ≥ 11.5.1。

## 开发

```sh
npm install
npm run check        # typecheck + test + build
npm run testenv      # 物化工作区内的隔离测试环境
testenv\run.cmd      # 在 127.0.0.1:63950 起一个独立的 web profile
```

### 隔离测试环境

`testenv/` 会把 `DSH_HOME` 指向 **工作区内** 的 `testenv/dsh-home/`，
并物化一个只属于本插件的 `web` profile（端口 63950，与你正在用的 63877 不冲突）。
因此：

- 插件的按账号凭据副本、宿主心跳、会话、设置全部落在 `testenv/dsh-home/`；
- 真实 `~/.dsh` 完全不被触碰；
- WorkBuddy 桌面端的 auth 文件只读，从不写入。

```sh
node testenv/setup.mjs                       # 物化/修复环境（可重复执行）
set DSH_HOME=D:\Project\dsh-wb2api\testenv\dsh-home
dsh web --no-open                            # 或直接跑 testenv\run.cmd
```

### 本仓库在本机沙箱下的三处适配

DSH 的 Windows 文件沙箱禁止任何「带管道的子进程」，本机的构建与测试因此
需要三处**本地**适配。前两处随仓库分发，且都只在沙箱内生效：

1. `vitest.config.ts` 使用 `pool: 'threads'`（默认的 `forks` 需要 spawn 子进程，
   在沙箱内直接 EPERM）。`threads` 用 MessagePort 通信，沙箱内外都能跑，
   因此这是仓库里的正式配置，不是临时补丁。
2. `testenv/setup.mjs` 通过文件系统探测 `dsh` 安装位置，而不是 `where`/`which`，
   原因同上。可用 `DSH_INSTALL` 覆盖。

第三处只影响本机 `node_modules`，**重装依赖后消失**，沙箱外也无需存在：

3. `node_modules/vite/dist/node/chunks/node.js` 里跳过 `net use` 探测
   （vite 用它枚举映射网络驱动器，纯优化；跳过后退化为 `fs.realpathSync.native`，
   正是 vite 在「没有网络驱动器」时的分支）。若在本机重装依赖后
   `npx vitest` 报 `spawn EPERM`，重新打这个补丁即可。

### 测试环境为什么要在仓库里补依赖链接

插件以 `link:` 方式装进测试 profile，但 Node 按仓库的**真实路径**解析它的导入，
于是像 `@deepseek-ai/dsh-launch-environment`（它是 `dsh-llm-pi-ai` 的 peer，
不是本插件的依赖）这类包会在仓库一侧找不到 —— npm 不安装 peer 的 peer。
`testenv/setup.mjs` 因此把安装目录里已有的包**补链**进
`node_modules/@deepseek-ai/`，且只补缺失的那些：仓库自己装的包保持原有版本。

## 已知限制

- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后可能需要跟进。
- **多账号基于两条路径**：卡片里的网页登录（自己拿到的凭据，与桌面端无关），
  以及桌面端留下的历史 auth 文件。上游没有公开的多账号 API，
  因此「同一个账号在别处登录」这件事插件无法感知；桌面端清理备份或退出登录后，
  对应账号会消失，卡片会把它标成「凭据缺失」。
- 网页登录只支持 WorkBuddy 官方的设备授权流程（浏览器里完成登录）。
  没有账号密码直登，也没有验证码代收 —— 那需要用户自己在页面上操作。
- 同一账号被多个 WorkBuddy 客户端同时刷新时，token 可能互相失效；
  插件的自有副本以「活得更久」为准，不会覆盖桌面端更新的登录。
- 积分查询按账号打上游计费接口，账号多时请用「刷新积分」按需触发，
  而不是依赖卡片轮询。
- **自动任务只能做「纯 API 能点亮」的那部分**。需要真实客户端交互的任务
  （召唤并使用专家、加载 Skill、用指定模型真实对话、夜猫子夜间窗口、
  真实捐款等）不会被尝试，卡片会标注原因。这些任务仍需在官方客户端里完成。
- 自动任务**每天只补差额、不重复消耗**：已领取或已达标的任务在发请求前就被跳过。
  同一轮里账号串行、上报之间有节流（1.05 秒），这是对齐参考实现实测的风控节奏；
  账号特别多时一轮会跑较久，属预期。
- 任务动作**不参与账号池的健康状态**：任务调用失败不会给账号记冷却/熔断，
  因为那不是对话链路的失败，罚停一个能正常对话的账号反而更糟。
- 任务列表按需拉取：**折叠时不请求**，展开（或点刷新 / 做任务）时才拉，
  每个 tab 每次页面加载只拉一次，**不随 60 秒轮询**。

## 致谢与来源

本插件的实现建立在以下已公开项目之上，**均为借鉴设计思路 + 独立实现**，
未整体复制任何参考项目的源码；每个源文件头部都标注了参考了谁、参考了什么、
本项目改动了什么：

| 项目 | 许可证 | 借鉴内容 |
|---|---|---|
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | MIT | 账号池调度语义、会话粘性、失败迁移、上游协议、设备授权登录流程、成长任务动作表与事件链口径 |
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | MIT | DSH 插件内核：凭据发现、上游客户端、shim 加固、适配器、卡片 |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT | 接入方案的原始验证（经上者转引） |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | MIT | 模型管理交互与 `dsm-*` 卡片样式（经上者转引） |
| [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model) | MIT | 卡片外壳与文案键约定（经上者转引） |
| [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) | Apache-2.0 | 插件结构与 provider 注册思路（间接转引） |

完整的许可证与义务说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 本项目与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联，未获其授权或认可。

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 dsh-wb2api