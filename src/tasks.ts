/**
 * Growth tasks: the daily "one-click finish" engine and its schedule.
 *
 * WorkBuddy pays credits for behavior the gateway observes as events — not for
 * pressing a button. A task therefore has two halves: REGISTERING for it
 * (`tasks/accept`, which produces no progress at all) and the BEHAVIOR that
 * actually scores it (a reported conversation event, a desktop-fingerprint
 * event chain, or a real chat). This module implements both, plus the bounded
 * re-read that waits for the gateway's asynchronous scoring before claiming.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 任务域的全部 wire 口径来自该项目：
 *   `internal/upstream/tasks.go`（列表 / accept / 领奖三端点，领奖走
 *   web 域 `/activity/growth/tasks/<code>/claim` 而非 CLI 域）、
 *   `internal/panel/autotask.go`（动作表、幂等跳过、异步计分的有界回读、
 *   批间节流）、`internal/scheduler/scheduler.go`（定时排程与窗口判定）、
 *   以及 `internal/upstream/desktop.go` 里各事件链的字段形状。
 * 改动：
 *   1. 排程从「一组小时点 + 常驻进程」简化为「每天一个本地时刻 + 启动后一次」，
 *      由 DSH 宿主进程的存活期决定，不再有独立网关进程；
 *   2. 每个动作声明自己需要的**前置条件**（例如某个任务的进度必须先达标），
 *      执行器按依赖顺序跑，跳过不满足的动作而不是发一条注定不计分的请求；
 *   3. 只做纯 API 可点亮、且不需要真实客户端交互的动作子集，其余任务在卡片里
 *      如实标注「需要客户端内操作」，不做无法验证的尝试。
 *
 * @module dsh-workbuddy2api/tasks
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyTask, WorkBuddyRegion, WorkBuddyUpstreamClient } from './upstream.ts'

/** The subset of the upstream client the task engine uses. */
export type WorkBuddyTaskClient = Pick<WorkBuddyUpstreamClient,
  'listTasks' | 'acceptTasks' | 'claimTaskReward' | 'reportChatActivity' | 'reportDesktopEvents' | 'reportWebEvents'>

/** How one action finished. */
export type WorkBuddyTaskOutcome = 'done' | 'skipped' | 'error' | 'unsupported'

/** One action's result, as the card renders it. */
export interface WorkBuddyTaskResult {
  taskCode: string
  /** What the action does, in the card's language. */
  desc: string
  outcome: WorkBuddyTaskOutcome
  message: string
  /** Progress before and after, e.g. `0/5` → `5/5`. */
  progressBefore?: string
  progressAfter?: string
  /** The reward this run collected, when it claimed one. */
  credit?: number
  energy?: number
}

/** What a run did, per account. */
export interface WorkBuddyTaskRunReport {
  accountId: string
  accountName: string
  results: WorkBuddyTaskResult[]
  /** Credits collected by this run. */
  credit: number
  energy: number
  startedAtMs: number
  finishedAtMs: number
}

/** One task plus what the engine can do about it. */
export interface WorkBuddyTaskView {
  task: WorkBuddyTask
  /** Whether an automated action exists for this task code. */
  automated: boolean
  /** Why it is not automated, when it is not. */
  unsupportedReason?: string
}
/** One automated action. */
interface WorkBuddyTaskAction {
  taskCode: string
  /** What the action does (shown before it runs). */
  desc: string
  /**
   * The behavior that scores the task. Returning a string reports a
   * non-fatal note; throwing means the action failed.
   */
  run(client: WorkBuddyTaskClient, credential: WorkBuddyCredential): Promise<string>
}

/** The desktop app's event chain for one successful conversation. */
function chatSequence(
  conversationId: string,
  requestId: string,
  messageId: string,
  modelId: string,
  modelName: string,
): Record<string, unknown>[] {
  const now = Date.now()
  return [
    {
      eventCode: 'agent_task_created',
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '',
      has_expert: false, expert_id: '', expert_name: '', expert_industry_id: '',
      has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: '', buddyName: '',
    },
    {
      eventCode: 'chat_message_send',
      messageId: messageId + '-assistant', historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_send',
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '',
      recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    },
    {
      eventCode: 'chat_message_response',
      messageId: messageId + '-assistant', responseModelId: modelId,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: now, traceId: requestId,
      conversationId,
      rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    },
    {
      eventCode: 'chat_message_status',
      messageId: messageId + '-assistant', messageErrorCode: '0',
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_response',
      mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      rootRequestId: requestId, parentConversationId: conversationId,
    },
  ]
}

/** A unique-enough id for one synthetic behavior event. */
function runId(prefix: string): string {
  return prefix + '-' + String(Date.now()) + '-' + Math.floor(Math.random() * 1e6).toString(36)
}

/**
 * The actions this plugin performs. Every entry is a behavior the reference
 * implementation verified as scorable through the API alone; anything that
 * needs a real client interaction is deliberately absent and is reported as
 * "needs the client" rather than attempted.
 */
const ACTIONS: readonly WorkBuddyTaskAction[] = [
  {
    taskCode: 'chat_5',
    desc: '上报 5 条对话活跃事件（按差额补足）',
    run: async (client, credential) => {
      // The action itself needs the task's current progress, so it re-reads.
      const tasks = await client.listTasks(credential)
      const task = tasks.find(entry => entry.taskCode === 'chat_5')
      const target = task !== undefined && task.target > 0 ? task.target : 5
      const need = target - (task?.current ?? 0)
      if (need <= 0) return '进度已达标，无需上报'
      for (let index = 0; index < need; index += 1) {
        await client.reportChatActivity(credential, runId('wb2api-chat5'), '')
        if (index < need - 1) await delay(REPORT_GAP_MS)
      }
      return '已补报 ' + String(need) + ' 条对话事件'
    },
  },
  {
    taskCode: 'RichMeow_Chat',
    desc: '按桌面端指纹上报一次完整对话事件链',
    run: async (client, credential) => {
      const id = runId('wb2api-rm')
      await client.reportDesktopEvents(credential, chatSequence(id, id + '-req', 'msg-' + id, 'fast-model', 'fast-model'))
      return '已上报桌面指纹对话链（agent_task_created → chat_response）'
    },
  },
  {
    taskCode: 'Buddy_App',
    desc: '上报「进入 Buddy 应用」事件链',
    run: async (client, credential) => {
      await client.reportDesktopEvents(credential, buddyAppSequence())
      return '已上报 buddyapp 进入五连事件'
    },
  },
  {
    taskCode: 'Buddy_App_QQ',
    desc: '上报「进入企鹅教师助手」事件链',
    run: async (client, credential) => {
      await client.reportDesktopEvents(credential, buddyAppSequence())
      return '已上报 buddyapp 进入五连事件'
    },
  },
  {
    taskCode: 'automation_1',
    desc: '上报「定时任务创建成功」事件',
    run: async (client, credential) => {
      await client.reportDesktopEvents(credential, [{
        eventCode: 'automated_task_create_suc', name: 'wb2api 自动化',
        source: 'manually', modelId: 'fast-model', modelIsThinking: true,
        connectorCount: 0, skills: '', skillCount: 0,
        scheduleType: 'once', mode: 'LOCAL',
      }])
      return '已上报定时任务创建事件'
    },
  },
  {
    taskCode: 'Library_read',
    desc: '上报「阅读资料库介绍」事件',
    run: async (client, credential) => {
      const pageUrl = 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm'
      await client.reportWebEvents(credential, [{
        eventCode: 'web_element_click', timestamp: Date.now(), reportDelay: 0,
        pageURL: pageUrl, elementId: 'library_doc_intro_click', elementName: 'WorkBuddy资料库介绍',
        os: 'Win32', arch: '', osVersion: '10.0',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        userId: credential.uid, userNickname: credential.nickname ?? '',
        enterpriseId: credential.enterpriseId ?? '',
      }])
      return '已上报资料库介绍阅读事件'
    },
  },
  {
    taskCode: 'template_5',
    desc: '上报「使用模板创建任务」事件组 ×5',
    run: async (client, credential) => {
      const templates: readonly (readonly [string, string])[] = [
        ['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审'],
      ]
      for (const [index, template] of templates.entries()) {
        const id = runId('wb2api-tpl-' + String(index))
        const events = chatSequence(id, id + '-req', 'msg-' + template[0], 'fast-model', 'fast-model')
        events.push(
          {
            eventCode: 'agent_task_created_with_template', mode: 'working',
            isCustomModel: false, id: template[0], name: template[1], requestId: id + '-req',
          },
          { eventCode: 'template_used', template_id: template[0], task_mode: 'working' },
        )
        await client.reportDesktopEvents(credential, events)
        if (index < templates.length - 1) await delay(TEMPLATE_GAP_MS)
      }
      return '已上报 template_used ×5'
    },
  },
  {
    taskCode: 'playbook_prompt',
    desc: '上报「灵感案例做同款」事件组',
    run: async (client, credential) => {
      const id = runId('wb2api-pb')
      const caseId = 'pm-gtm-launch-plan'
      const caseName = '新产品上市 GTM 发布计划一页纸'
      const events = chatSequence(id, id + '-req', 'msg-pb', 'fast-model', 'fast-model')
      events.push(
        {
          eventCode: 'web_element_click', pageName: 'playbook_detail',
          elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover',
        },
        {
          eventCode: 'playbook_cta_click', source: 'discover', position: 0,
          id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '',
        },
        {
          eventCode: 'playbook_prompt_send', conversationId: id, requestId: id + '-req',
          id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '',
        },
      )
      await client.reportDesktopEvents(credential, events)
      return '已上报 playbook_cta_click + playbook_prompt_send'
    },
  },
  {
    taskCode: 'create_canvas',
    desc: '上报「设计创意画布创建」事件组',
    run: async (client, credential) => {
      const id = runId('wb2api-canvas')
      const requestId = id + '-req'
      const events = chatSequence(id, requestId, 'msg-canvas', 'fast-model', 'fast-model')
      events.push(
        {
          eventCode: 'wbx_design_canvas_task_create', conversationId: id,
          requestId, source: 'summon_keyword', cost: 12000, isSuccessful: true,
        },
        {
          eventCode: 'wbx_design_canvas_open', conversationId: id,
          requestId, id: 'ardot-file-' + requestId.slice(-8),
          source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true,
        },
      )
      await client.reportDesktopEvents(credential, events)
      return '已上报 wbx_design_canvas_task_create/open'
    },
  },
  {
    taskCode: 'Hp_Appearance',
    desc: '上报「主题皮肤生效」事件',
    run: async (client, credential) => {
      await client.reportDesktopEvents(credential, [{
        eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close',
        id: 'theme-tkmw7j', vipLevel: 0, series: '', type: 'unknown',
      }])
      return '已上报皮肤生效事件'
    },
  },
]

/** The buddyapp entry chain, shared by the two buddy-app tasks. */
function buddyAppSequence(): Record<string, unknown>[] {
  const buddyId = 'cb_y5Dy46tPQGGWtueMxXbe'
  const buddyName = '企鹅教师助手'
  const mk = (eventCode: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ eventCode, mode: 'LOCAL', buddyId, buddyName, ...extra })
  return [
    mk('buddyapp_discover_click'),
    mk('buddyapp_show', { elementId: buddyId, elementName: buddyName, position: 2 }),
    mk('buddyapp_enter_click', { elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: '1' }),
    mk('buddyapp_auth_confirm_click', { elementId: buddyId, elementName: buddyName }),
    mk('buddyapp_bindaccount_skip_click', { elementId: buddyId, elementName: buddyName }),
  ]
}

/** Tasks that exist upstream but need a real client interaction to score. */
const CLIENT_ONLY: Readonly<Record<string, string>> = {
  first_buddy: '需要先有当日活跃记录并同意领养协议，属客户端交互',
  'Model_chat_GLM5.2': '需要在客户端里用指定模型真实对话',
  expert_5: '需要在专家市场召唤并使用 5 位真实专家',
  Expert_team_use_3: '需要在专家市场召唤并使用 3 个专家团',
  Expert_lighthouse: '需要连接器授权与真实专家会话',
  Expert_Philanthropy: '需要真实捐款',
  skill_1: '需要真实 Skill 工具调用',
  black_cat: '仅 23:00–08:00 窗口内计数，且需真实夜间对话',
  share_invite: '需要分享邀请链接',
}

/** Gap between two reported events, matching the reference's measured pace. */
const REPORT_GAP_MS = 1_050
/** Gap between the five template event groups. */
const TEMPLATE_GAP_MS = 300
/** How many times the runner re-reads a task waiting for the gateway to score. */
const CLAIM_POLL_ATTEMPTS = 4
/** Gap between those re-reads (the gateway scores asynchronously). */
const CLAIM_POLL_GAP_MS = 3_000

/** Sleep, injectable so tests never wait on real time. */
let delayImpl = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Replace the sleep implementation (tests only). */
export function setWorkBuddyTaskDelay(delay: (ms: number) => Promise<void>): void {
  delayImpl = delay
}

/** Sleep through the module's injected delay. */
function delay(ms: number): Promise<void> {
  return delayImpl(ms)
}

/** The action for one task code, when there is one. */
export function actionFor(taskCode: string): WorkBuddyTaskAction | undefined {
  return ACTIONS.find(action => action.taskCode === taskCode)
}

/** Every task code this plugin can finish on its own. */
export function automatedTaskCodes(): readonly string[] {
  return ACTIONS.map(action => action.taskCode)
}

/** Why a task cannot be automated, or undefined when it can. */
export function unsupportedReasonFor(taskCode: string): string | undefined {
  if (actionFor(taskCode) !== undefined) return undefined
  return CLIENT_ONLY[taskCode] ?? '该任务没有对应的纯 API 行为，需要在官方客户端内操作'
}
/** The engine's dependencies. */
export interface WorkBuddyTaskEngineOptions {
  client: WorkBuddyTaskClient
  /** Live tasks for one account, annotated with what can be automated. */
  list(credential: WorkBuddyCredential): Promise<WorkBuddyTask[]>
  /** Log one line; the host passes its own logger. */
  log?(message: string): void
}

/**
 * The task engine: one run per account, actions in a fixed order, every action
 * idempotent (an already-claimed or already-complete task is skipped before its
 * behavior is reported, so a second run never burns a second request).
 */
export class WorkBuddyTaskEngine {
  private readonly options: WorkBuddyTaskEngineOptions

  constructor(options: WorkBuddyTaskEngineOptions) {
    this.options = options
  }

  /** The task list, each entry annotated with whether it can be automated. */
  async view(credential: WorkBuddyCredential): Promise<WorkBuddyTaskView[]> {
    const tasks = await this.options.list(credential)
    return tasks.map(task => {
      const reason = unsupportedReasonFor(task.taskCode)
      return reason === undefined
        ? { task, automated: true }
        : { task, automated: false, unsupportedReason: reason }
    })
  }

  /**
   * Finish every automatable task for one account.
   *
   * Registration happens first and in one batch (the gateway has no documented
   * limit on the array, so it is sent whole); it is not what produces progress,
   * but it keeps the state machine regular. Then each action runs in order,
   * re-reading the task list before and after so the report says what actually
   * changed rather than what was merely requested.
   */
  async run(
    credential: WorkBuddyCredential,
    options: { taskCodes?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<WorkBuddyTaskRunReport> {
    const startedAtMs = Date.now()
    const results: WorkBuddyTaskResult[] = []
    const wanted = options.taskCodes === undefined ? undefined : new Set(options.taskCodes)

    let tasks: WorkBuddyTask[] = []
    try {
      tasks = await this.options.list(credential)
    } catch (error: unknown) {
      return {
        accountId: credential.uid,
        accountName: credential.nickname ?? credential.uin ?? credential.uid,
        results: [{
          taskCode: '(查询任务)',
          desc: '读取任务列表',
          outcome: 'error',
          message: messageOf(error),
        }],
        credit: 0,
        energy: 0,
        startedAtMs,
        finishedAtMs: Date.now(),
      }
    }

    // Register for everything not yet accepted, so the state machine is
    // regular before the behavior events arrive.
    const toAccept = tasks
      .filter(task => !task.claimed && !task.locked
        && task.acceptStatus !== 'accepted' && task.acceptStatus !== 'completed')
      .map(task => task.taskCode)
    if (toAccept.length > 0) {
      try {
        await this.options.client.acceptTasks(credential, toAccept)
        results.push({
          taskCode: '(报名)',
          desc: '接受尚未接受的任务',
          outcome: 'done',
          message: '已接受 ' + String(toAccept.length) + ' 个任务',
        })
        await delay(REPORT_GAP_MS)
      } catch (error: unknown) {
        results.push({
          taskCode: '(报名)',
          desc: '接受尚未接受的任务',
          outcome: 'error',
          message: '接受任务失败（不阻塞后续）: ' + messageOf(error),
        })
      }
    }

    for (const action of ACTIONS) {
      if (wanted !== undefined && !wanted.has(action.taskCode)) continue
      if (options.signal?.aborted === true) break
      const before = tasks.find(task => task.taskCode === action.taskCode)
      const item: WorkBuddyTaskResult = {
        taskCode: action.taskCode,
        desc: action.desc,
        outcome: 'done',
        message: '',
        ...before === undefined ? {} : { progressBefore: progressText(before) },
      }
      if (before === undefined) {
        results.push({ ...item, outcome: 'skipped', message: '该账号没有此任务' })
        continue
      }
      if (before.claimed || (before.target > 0 && before.current >= before.target)) {
        results.push({ ...item, outcome: 'skipped', message: '已完成（' + progressText(before) + '）' })
        continue
      }
      try {
        const note = await action.run(this.options.client, credential)
        item.message = note
      } catch (error: unknown) {
        results.push({ ...item, outcome: 'error', message: messageOf(error) })
        continue
      }
      // Reporting is not scoring: the gateway scores asynchronously, so the
      // runner waits (bounded) before deciding whether to claim.
      const after = await this.settled(credential, action.taskCode, options.signal)
      if (after !== undefined) item.progressAfter = progressText(after)
      if (after !== undefined && after.claimable) {
        try {
          const reward = await this.options.client.claimTaskReward(credential, action.taskCode)
          item.credit = reward.credit
          item.energy = reward.energy
          item.message = reward.alreadyClaimed
            ? item.message + '；奖励此前已领取'
            : item.message + '；已领奖 +' + String(reward.credit) + ' 分 +' + String(reward.energy) + ' 能'
        } catch (error: unknown) {
          item.message = item.message + '；达标但领奖失败（可在任务列表重试）: ' + messageOf(error)
        }
      }
      results.push(item)
      await delay(REPORT_GAP_MS)
    }

    const credit = results.reduce((sum, item) => sum + (item.credit ?? 0), 0)
    const energy = results.reduce((sum, item) => sum + (item.energy ?? 0), 0)
    this.options.log?.(
      'tasks: ' + (credential.nickname ?? credential.uid) + ' 完成 ' + String(results.length)
      + ' 项，+ ' + String(credit) + ' 分 +' + String(energy) + ' 能',
    )
    return {
      accountId: credential.uid,
      accountName: credential.nickname ?? credential.uin ?? credential.uid,
      results,
      credit,
      energy,
      startedAtMs,
      finishedAtMs: Date.now(),
    }
  }

  /**
   * Re-read one task until it is settled (claimable or claimed) or the bounded
   * budget runs out. The gateway's scoring is asynchronous — a re-read right
   * after a report still shows the old progress for several seconds.
   */
  private async settled(
    credential: WorkBuddyCredential,
    taskCode: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyTask | undefined> {
    let last: WorkBuddyTask | undefined
    for (let attempt = 0; attempt < CLAIM_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(CLAIM_POLL_GAP_MS)
      if (signal?.aborted === true) return last
      try {
        const tasks = await this.options.list(credential)
        last = tasks.find(task => task.taskCode === taskCode) ?? last
      } catch {
        // A failed re-read never overwrites what we already know.
        return last
      }
      if (last?.claimable === true || last?.claimed === true) return last
    }
    return last
  }
}

/** A task's progress as text, for the report and the card. */
export function progressText(task: WorkBuddyTask): string {
  if (task.target > 0) return String(task.current) + '/' + String(task.target)
  if (task.claimed) return 'claimed'
  return task.acceptStatus ?? '?'
}

/** An error's message, never a bare `[object Object]`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/** The persisted daily-task configuration. */
export interface WorkBuddyTaskSchedule {
  /** Run the daily sweep automatically. */
  enabled: boolean
  /** Local hour (0–23) the daily sweep starts at. */
  hour: number
  /** Local minute (0–59) the daily sweep starts at. */
  minute: number
  /** Run one sweep shortly after the plugin starts. */
  runOnStart: boolean
  /** Run only for accounts whose region matches. */
  regions?: readonly WorkBuddyRegion[]
}

/** What the scheduler did last, for the card. */
export interface WorkBuddyTaskScheduleStatus {
  /** Epoch ms of the next planned sweep. */
  nextRunAtMs?: number
  /** Epoch ms of the last sweep that actually ran. */
  lastRunAtMs?: number
  /** Reports of the last sweep, one per account. */
  lastReports: readonly WorkBuddyTaskRunReport[]
  /** Accounts the last sweep skipped, with why. */
  lastSkipped: readonly { accountName: string; reason: string }[]
  /** Whether a sweep is running right now. */
  running: boolean
  /** Whether the plugin runs a startup sweep. */
  runOnStart: boolean
  /** The configured daily time, as `HH:MM`. */
  dailyAt: string
}

/** The next occurrence of a local wall-clock time, strictly after `from`. */
export function nextDailyRunAt(hour: number, minute: number, from: number = Date.now()): number {
  const safeHour = Math.min(Math.max(Math.trunc(hour), 0), 23)
  const safeMinute = Math.min(Math.max(Math.trunc(minute), 0), 59)
  const next = new Date(from)
  next.setHours(safeHour, safeMinute, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** Constructor dependencies of the scheduler. */
export interface WorkBuddyTaskSchedulerOptions {
  engine: WorkBuddyTaskEngine
  /** The accounts to sweep, with the region each belongs to. */
  accounts(): Promise<readonly { credential: WorkBuddyCredential; region: WorkBuddyRegion }[]>
  /** Current configuration (re-read before every sweep). */
  schedule(): WorkBuddyTaskSchedule
  /** Delay between two accounts' sweeps. */
  accountGapMs?: number
  log?(message: string): void
  now?(): number
}

/**
 * Runs the task sweep on a daily wall-clock time and, optionally, once shortly
 * after startup. Both triggers call the same serialized sweep, so a startup run
 * that happens to land next to the daily one cannot run twice at once.
 */
export class WorkBuddyTaskScheduler {
  private readonly options: WorkBuddyTaskSchedulerOptions
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextRunAtMs: number | undefined
  private lastRunAtMs: number | undefined
  private lastReports: WorkBuddyTaskRunReport[] = []
  private lastSkipped: { accountName: string; reason: string }[] = []
  /** Whether a sweep is running right now (reported to the card). */
  private running = false
  /** The sweep in flight, so a second caller joins it instead of racing it. */
  private inflight: Promise<WorkBuddyTaskRunReport[]> | undefined
  private disposed = false
  private startupTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: WorkBuddyTaskSchedulerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  /** Arm the timers; safe to call again after a configuration change. */
  start(): void {
    if (this.disposed) return
    this.clearTimers()
    const schedule = this.options.schedule()
    if (schedule.enabled) this.armDaily()
    if (schedule.runOnStart) {
      // Give the host a moment to finish starting (the pool scan, the catalog
      // refresh) so the sweep does not compete with it for the same accounts.
      this.startupTimer = setTimeout(() => {
        this.startupTimer = undefined
        void this.sweep('startup')
      }, STARTUP_DELAY_MS)
    }
  }

  /** Stop every timer; the scheduler cannot be restarted afterwards. */
  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  /** What the card shows about the schedule. */
  status(): WorkBuddyTaskScheduleStatus {
    const schedule = this.options.schedule()
    const hour = Math.min(Math.max(Math.trunc(schedule.hour), 0), 23)
    const minute = Math.min(Math.max(Math.trunc(schedule.minute), 0), 59)
    return {
      ...this.nextRunAtMs === undefined ? {} : { nextRunAtMs: this.nextRunAtMs },
      ...this.lastRunAtMs === undefined ? {} : { lastRunAtMs: this.lastRunAtMs },
      lastReports: this.lastReports,
      lastSkipped: this.lastSkipped,
      running: this.running,
      runOnStart: schedule.runOnStart,
      dailyAt: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
    }
  }

  /** Run one sweep now (the card's button and the timers share this path). */
  async runNow(): Promise<WorkBuddyTaskRunReport[]> {
    return this.sweep('manual')
  }

  private armDaily(): void {
    const schedule = this.options.schedule()
    const next = nextDailyRunAt(schedule.hour, schedule.minute, this.now())
    this.nextRunAtMs = next
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sweep('daily').finally(() => {
        // Re-arm from the CURRENT configuration: the user may have changed the
        // time while this sweep was running.
        if (!this.disposed) this.armDaily()
      })
    }, Math.max(next - this.now(), 0))
  }

  /**
   * One sweep over every eligible account. Accounts run one at a time: the
   * upstream throttles behavior reports, and the sweep's own pacing (a gap
   * between accounts) is what keeps a multi-account install from tripping it.
   */
  private async sweep(trigger: 'startup' | 'daily' | 'manual'): Promise<WorkBuddyTaskRunReport[]> {
    // A sweep already in flight is joined, not duplicated: two passes over the
    // same accounts would double every report the gateway sees.
    if (this.inflight !== undefined) return this.inflight
    const run = this.runSweep(trigger).finally(() => { this.inflight = undefined })
    this.inflight = run
    return run
  }

  private async runSweep(trigger: 'startup' | 'daily' | 'manual'): Promise<WorkBuddyTaskRunReport[]> {
    this.running = true
    const reports: WorkBuddyTaskRunReport[] = []
    const skipped: { accountName: string; reason: string }[] = []
    try {
      const schedule = this.options.schedule()
      const allowed = schedule.regions === undefined || schedule.regions.length === 0
        ? undefined
        : new Set(schedule.regions)
      const accounts = await this.options.accounts()
      for (const account of accounts) {
        // The international gateway has no growth-task system at all, so its
        // accounts are never swept — the call would only 404. This is checked
        // before the region filter because it is the more useful answer: it
        // tells the user why, rather than implying a switch is off.
        if (account.region !== 'cn') {
          skipped.push({
            accountName: account.credential.nickname ?? account.credential.uid,
            reason: '国际版没有任务体系',
          })
          continue
        }
        if (allowed !== undefined && !allowed.has(account.region)) {
          skipped.push({
            accountName: account.credential.nickname ?? account.credential.uid,
            reason: '该区域未开启自动任务',
          })
          continue
        }
        try {
          reports.push(await this.options.engine.run(account.credential))
        } catch (error: unknown) {
          skipped.push({
            accountName: account.credential.nickname ?? account.credential.uid,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
        await new Promise(resolve => setTimeout(resolve, this.options.accountGapMs ?? ACCOUNT_GAP_MS))
      }
      this.lastRunAtMs = this.now()
      this.lastReports = reports
      this.lastSkipped = skipped
      const credit = reports.reduce((sum, report) => sum + report.credit, 0)
      this.options.log?.(
        'tasks: ' + trigger + ' 自动任务完成，' + String(reports.length) + ' 个账号，共 +'
        + String(credit) + ' 分',
      )
      return reports
    } finally {
      this.running = false
    }
  }

  private clearTimers(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.timer = undefined
    this.startupTimer = undefined
    this.nextRunAtMs = undefined
  }
}

/** Delay between two accounts inside one sweep. */
const ACCOUNT_GAP_MS = 3_000
/** How long after startup the optional first sweep runs. */
const STARTUP_DELAY_MS = 20_000

/** The schedule in force when the user configured nothing. */
export const DEFAULT_WORKBUDDY_TASK_SCHEDULE: WorkBuddyTaskSchedule = {
  enabled: true,
  hour: 0,
  minute: 5,
  runOnStart: true,
}
