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
 *   3. **动作表对齐参考实现的全部可自动化任务**（17 个）：包括需要真实对话的那几个
 *      （专家召唤+使用、skill_info、指定模型对话、夜猫子），它们同样只需 API ——
 *      真实对话由本插件自己发，事件的 requestId 取**服务端返回的那个**；
 *      只有「需要真实付款」和「需要打扰第三方」的两个任务不做。
 *
 * @module dsh-workbuddy2api/tasks
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyMarketExpert, WorkBuddyTask, WorkBuddyRegion, WorkBuddyUpstreamClient } from './upstream.ts'
import { isNightWindow } from './upstream.ts'

/** The subset of the upstream client the task engine uses. */
export type WorkBuddyTaskClient = Pick<WorkBuddyUpstreamClient,
  | 'listTasks' | 'acceptTasks' | 'claimTaskReward'
  | 'reportChatActivity' | 'reportDesktopEvents' | 'reportWebEvents'
  | 'marketExpertList' | 'desktopChatTurn' | 'claimGift' | 'buddyAgreement' | 'buddyFirst'>

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
/** What an action reports back: a note, optionally declaring it did nothing. */
export type WorkBuddyTaskActionOutcome = string | { message: string; skipped: true }

/** One automated action. */
export interface WorkBuddyTaskAction {
  taskCode: string
  /** What the action does (shown before it runs). */
  desc: string
  /**
   * The behavior that scores the task.
   *
   * Returning a string reports work done; returning `{skipped: true}` states
   * that nothing was attempted and why (a closed scoring window, a threshold
   * that is not met yet) — the two must not be conflated, or the card would
   * claim credit for a task that was never even reported. Throwing means the
   * action failed.
   */
  run(client: WorkBuddyTaskClient, credential: WorkBuddyCredential): Promise<WorkBuddyTaskActionOutcome>
}

/** Split an action's answer into the note and whether it actually did work. */
function readOutcome(outcome: WorkBuddyTaskActionOutcome): { message: string; skipped: boolean } {
  return typeof outcome === 'string'
    ? { message: outcome, skipped: false }
    : { message: outcome.message, skipped: true }
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
  {
    taskCode: 'first_buddy',
    desc: '活跃上报 → 同意协议 → 领取第一只 Buddy',
    run: async (client, credential) => {
      // The adoption threshold is "active today", so the activity report comes
      // first; without it `buddy/first` answers "task not completed yet".
      await client.reportChatActivity(credential, runId('wb2api-adopt'), '')
      await delay(REPORT_GAP_MS)
      await client.buddyAgreement(credential)
      const adopted = await client.buddyFirst(credential)
      return adopted.message
    },
  },
  {
    taskCode: 'Model_chat_GLM5.2',
    desc: '真实 glm-5.2 对话一次 + 对齐模型的上报',
    run: async (client, credential) => {
      // A REAL turn (the gateway scores the conversation, not the report), then
      // a report whose model fields match what was actually used.
      await client.desktopChatTurn(credential, { model: NIGHT_MODEL.id })
      await delay(REPORT_GAP_MS)
      await client.reportChatActivity(credential, runId('wb2api-glm52'), '', NIGHT_MODEL)
      return '已完成 glm-5.2 对话并上报'
    },
  },
  expertBatchAction('expert_5', '召唤并使用 5 位平台专家（真实列表 + 真实对话）', 'agent', 5),
  expertBatchAction('Expert_team_use_3', '召唤并使用 3 个专家团（真实列表 + 真实对话）', 'team', 3),
  {
    taskCode: 'skill_1',
    desc: '真实对话 + skill_info 技能加载事件',
    run: async (client, credential) => {
      const turn = await client.desktopChatTurn(credential, {})
      const messageId = 'msg-' + turn.requestId.slice(-8)
      const events = chatSequence(turn.conversationId, turn.requestId, messageId, 'fast-model', 'fast-model')
      for (const event of events) {
        // The task's own criterion: the turn ended by loading a skill.
        if (event['eventCode'] === 'chat_message_response') event['finishReason'] = 'tool_calls'
      }
      events.push({
        eventCode: 'skill_info',
        id: '润泽小馆·日报撰写',
        skillId: 'skill_2097350077599879168',
        skillVersion: '1.0.0',
        toolStatus: 'success',
        fileCount: 56,
        source: 'workbuddy-desktop',
        conversationId: turn.conversationId,
        requestId: turn.requestId,
        messageId,
        requestModelId: 'fast-model',
        requestModelName: 'fast-model',
        traceId: turn.requestId,
      })
      await client.reportDesktopEvents(credential, events)
      return '已上报真实对话 + skill_info 技能加载事件'
    },
  },
  {
    taskCode: 'Expert_lighthouse',
    desc: '腾讯轻量云专家：召唤链 + 真实对话（mode=LOCAL）',
    run: async (client, credential) => {
      // Prefer the market's own record for this expert (its version is the
      // server's); fall back to the known id when it is not on page one.
      let expert: WorkBuddyMarketExpert = {
        expertId: LIGHTHOUSE_EXPERT_ID, expertType: 'agent',
        name: '腾讯轻量云专家', profession: '腾讯轻量云专家', version: '1.0.2', category: 'expert-all',
      }
      try {
        const found = (await client.marketExpertList(credential, 'agent'))
          .find(entry => entry.expertId === LIGHTHOUSE_EXPERT_ID)
        if (found !== undefined) expert = found
      } catch {
        // The market is an optimisation here, not a requirement.
      }
      await client.reportDesktopEvents(credential, expertSummonSequence(expert))
      const turn = await client.desktopChatTurn(credential, { expertId: expert.expertId })
      const events = chatSequence(
        turn.conversationId,
        turn.requestId,
        'msg-' + turn.requestId.slice(-8),
        'fast-model',
        'fast-model',
      )
      for (const event of events) {
        // The real sample this criterion came from carries the expert on the
        // task-created event, and its use event is LOCAL with no cost.
        if (event['eventCode'] === 'agent_task_created') {
          event['has_expert'] = true
          event['expert_id'] = expert.expertId
          event['expert_name'] = expert.name
          event['expert_industry_id'] = ''
        }
      }
      const use = expertActualUse(expert, turn.conversationId, turn.requestId, 'LOCAL')
      use['type'] = ''
      use['cost'] = 0
      events.push(use)
      await client.reportDesktopEvents(credential, events)
      return '已上报轻量云专家召唤+使用链（真实对话 requestId）'
    },
  },
  {
    taskCode: 'black_cat',
    desc: '夜间窗口内补足 glm-5.2 真实对话（23:00–08:00）',
    run: async (client, credential) => {
      // Outside the window the behavior is not scored at all, so a sweep that
      // runs at 00:05 must say so rather than burn three real conversations.
      if (!isNightWindow()) {
        return { skipped: true, message: '当前不在 23:00–08:00 计数窗口，本轮不做（发了也不计分）' }
      }
      const tasks = await client.listTasks(credential)
      const task = tasks.find(entry => entry.taskCode === 'black_cat')
      const need = task === undefined || task.target <= 0 ? 0 : Math.max(task.target - task.current, 0)
      if (need === 0) return '进度已达标，无需补足'
      let done = 0
      for (let index = 0; index < need; index += 1) {
        await client.desktopChatTurn(credential, { model: NIGHT_MODEL.id })
        await client.reportChatActivity(credential, runId('wb2api-night-' + String(index)), '', NIGHT_MODEL)
        done += 1
        if (index < need - 1) await delay(4_000)
      }
      return '已完成 ' + String(done) + ' 次夜间对话并上报'
    },
  },
]


/** The event pair that scores one expert: summon, then genuine use. */
function expertSummonSequence(expert: WorkBuddyMarketExpert): Record<string, unknown>[] {
  return [
    {
      eventCode: 'web_element_click', source: expert.expertId, type: expert.category, version: expert.version,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click', id: expert.expertId, name: expert.name,
      expertTitle: expert.profession, type: 'expert-all', position: 0,
      expertType: expert.expertType, version: expert.version, mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned', id: expert.expertId, name: expert.name,
      expertTitle: expert.profession, type: 'expert-all',
    },
  ]
}

/** The `expert_actual_use` event, joined onto a real conversation. */
function expertActualUse(
  expert: WorkBuddyMarketExpert,
  conversationId: string,
  requestId: string,
  mode: 'craft' | 'LOCAL',
): Record<string, unknown> {
  return {
    eventCode: 'expert_actual_use',
    id: expert.expertId, name: expert.name, expertTitle: expert.profession,
    type: expert.category, expertType: expert.expertType, source: 'builtin', version: expert.version,
    cost: 9000, characterCount: 14,
    conversationId, requestId, messageId: 'msg-' + requestId.slice(-8),
    requestModelId: 'fast-model', requestModelName: 'fast-model',
    mode,
  }
}

/** The model the nightly task is scored with. */
const NIGHT_MODEL = { id: 'glm-5.2', name: 'GLM-5.2' }

/**
 * The light-cloud expert `Expert_lighthouse` is scored on. The market list is
 * preferred for its metadata, but the id is a known constant so the action
 * still works when the expert is not on the market's first page.
 */
const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ'

/** Gap between two real chat turns inside one chained action. */
const EXPERT_GAP_MS = 6_000

/**
 * Summon and genuinely use `count` experts of one market type.
 *
 * The market is listed first because the scoring events must carry REAL expert
 * ids — an invented id reports 200 and never scores. The chat turn is real
 * because the use event must JOIN the server's own request id. One expert
 * failing must not abort the batch, so failures are counted and the loop moves
 * on: the task only needs `count` successes out of the market list.
 */
function expertBatchAction(
  taskCode: string,
  desc: string,
  expertType: 'agent' | 'team',
  count: number,
): WorkBuddyTaskAction {
  return {
    taskCode,
    desc,
    run: async (client, credential) => {
      const experts = await client.marketExpertList(credential, expertType)
      if (experts.length === 0) throw new Error('专家市场列表为空')
      let done = 0
      let failed = 0
      for (const [index, expert] of experts.entries()) {
        if (done >= count) break
        try {
          await client.reportDesktopEvents(credential, expertSummonSequence(expert))
          const turn = await client.desktopChatTurn(credential, { expertId: expert.expertId })
          await client.reportDesktopEvents(credential, [
            ...chatSequence(
              turn.conversationId,
              turn.requestId,
              'msg-' + turn.requestId.slice(-8),
              'fast-model',
              'fast-model',
            ),
            expertActualUse(expert, turn.conversationId, turn.requestId, 'craft'),
          ])
          done += 1
        } catch {
          failed += 1
        }
        if (index < experts.length - 1 && done < count) await delay(EXPERT_GAP_MS)
      }
      if (done === 0) throw new Error('专家召唤链全部失败（' + String(failed) + ' 位）')
      return '已对 ' + String(done) + ' 位真实专家完成召唤+使用链（' + expertType + '）'
    },
  }
}

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

/**
 * Tasks the upstream offers but that this plugin does NOT automate, each with
 * the reason the card shows.
 *
 * The bar for an entry here is "no API path exists", not "the API path is
 * involved": every other task is scored on behavior that can be reported, even
 * when that means a real chat turn. Only the two below genuinely cannot be
 * driven from here.
 */
const CLIENT_ONLY: Readonly<Record<string, string>> = {
  Expert_Philanthropy: '需要真实捐款（涉及真实支付，插件不会代做）',
  share_invite: '需要把邀请链接分享给他人（插件不代替用户打扰别人）',
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
      let skipped = false
      try {
        const answer = readOutcome(await action.run(this.options.client, credential))
        item.message = answer.message
        skipped = answer.skipped
      } catch (error: unknown) {
        results.push({ ...item, outcome: 'error', message: messageOf(error) })
        continue
      }
      if (skipped) {
        // Nothing was reported, so there is nothing to wait for and nothing to
        // claim: saying "done" here would be a false record of what happened.
        results.push({ ...item, outcome: 'skipped' })
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
  /** Whether the daily sweep is armed. */
  enabled: boolean
  /**
   * The configured daily time, as numbers `hour`/`minute` — the card edits
   * these, so it must receive them. `dailyAt` is only their display form.
   */
  hour: number
  minute: number
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
      enabled: schedule.enabled,
      // The card renders and edits these, so they travel as numbers; `dailyAt`
      // is derived here for display only and must never be parsed back.
      hour,
      minute,
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
