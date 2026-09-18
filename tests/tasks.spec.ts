/**
 * Growth-task behaviour: the action table, the runner's idempotence, and the
 * daily/startup schedule.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 用例对应其任务链路的关键不变量
 *   （accept 不产生进度、上报后需有界回读等待异步计分、已领取的任务直接跳过、
 *   领奖走 web 域路径）。改动：新增「区域门控」（国际版不发任何任务调用）
 *   与「排程时刻计算」两组用例。
 */

import { describe, expect, it } from 'vitest'
import {
  automatedTaskCodes,
  nextDailyRunAt,
  setWorkBuddyTaskDelay,
  unsupportedReasonFor,
  WorkBuddyTaskEngine,
  WorkBuddyTaskScheduler,
} from '../src/tasks.ts'
import type { WorkBuddyTaskClient } from '../src/tasks.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyTask } from '../src/upstream.ts'

/** A credential for the domestic gateway. */
function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.cn',
    uid: 'uid-1',
    nickname: 'tester',
    source: 'desktop',
    filePath: '/x.info',
    ...overrides,
  }
}

/** One task with defaults for everything the tests do not care about. */
function task(taskCode: string, overrides: Partial<WorkBuddyTask> = {}): WorkBuddyTask {
  return {
    taskCode,
    credit: 100,
    energy: 1,
    hasReward: true,
    locked: false,
    target: 1,
    current: 0,
    claimable: false,
    claimed: false,
    ...overrides,
  }
}

/** A recording fake upstream: the task list is scripted, calls are logged. */
function fakeClient(options: {
  tasks: WorkBuddyTask[]
  /** Called after every listTasks so a test can model the gateway scoring. */
  onList?(): void
  claim?: (taskCode: string) => { credit: number; energy: number; alreadyClaimed: boolean }
  /** The expert market this fake answers with. */
  experts?: (expertType: 'agent' | 'team') => {
    expertId: string
    expertType: string
    name: string
    profession: string
    version: string
    category: string
  }[]
  /** Whether the real chat turn succeeds. */
  chatTurnFails?: boolean
}): { client: WorkBuddyTaskClient; calls: string[] } {
  const calls: string[] = []
  const client: WorkBuddyTaskClient = {
    async listTasks() {
      calls.push('list')
      const snapshot = options.tasks.map(entry => ({ ...entry }))
      options.onList?.()
      return snapshot
    },
    async acceptTasks(_credential, codes) {
      calls.push('accept:' + codes.join(','))
    },
    async claimTaskReward(_credential, taskCode) {
      calls.push('claim:' + taskCode)
      return options.claim?.(taskCode) ?? { credit: 100, energy: 1, alreadyClaimed: false }
    },
    async reportChatActivity() {
      calls.push('report-chat')
    },
    async reportDesktopEvents(_credential, events) {
      calls.push('report-desktop:' + String(events.length))
    },
    async reportWebEvents(_credential, events) {
      calls.push('report-web:' + String(events.length))
    },
    async marketExpertList(_credential, expertType) {
      calls.push('expert-list:' + expertType)
      return options.experts?.(expertType) ?? []
    },
    async desktopChatTurn(_credential, turn = {}) {
      calls.push('chat-turn' + (turn.expertId === undefined ? '' : ':' + turn.expertId))
      if (options.chatTurnFails === true) throw new Error('chat refused')
      return {
        conversationId: 'conv-' + String(calls.length),
        // The server's own id shape: what the expert/skill events must JOIN.
        requestId: 'cmb-' + 'a'.repeat(32),
      }
    },
    async claimGift() {
      calls.push('claim-gift')
      return 0
    },
    async buddyAgreement() {
      calls.push('buddy-agreement')
    },
    async buddyFirst() {
      calls.push('buddy-first')
      return { adopted: true, message: '已领取 Buddy（+300 分 +8 能量）' }
    },
  }
  return { client, calls }
}

/** Run `body` with the engine's sleeps removed. */
async function instantly(body: () => Promise<void>): Promise<void> {
  setWorkBuddyTaskDelay(async () => {})
  try {
    await body()
  } finally {
    setWorkBuddyTaskDelay(ms => new Promise(resolve => setTimeout(resolve, ms)))
  }
}
describe('the action table', () => {
  it('covers every task the reference implementation automates', () => {
    // The bar is "no API path exists", not "the API path is involved": the
    // reference automates 17 tasks, including the ones needing a REAL chat turn
    // (which this plugin sends itself and whose events JOIN the server's own
    // request id). Only real payment and pestering third parties are excluded.
    const codes = automatedTaskCodes()
    const reference = ['chat_5', 'first_buddy', 'Model_chat_GLM5.2', 'RichMeow_Chat', 'Buddy_App',
      'Buddy_App_QQ', 'automation_1', 'Library_read', 'template_5', 'playbook_prompt',
      'create_canvas', 'expert_5', 'Expert_team_use_3', 'Hp_Appearance', 'skill_1',
      'Expert_lighthouse', 'black_cat']
    expect(reference).toHaveLength(17)
    for (const code of reference) expect(codes).toContain(code)
    expect(codes).toHaveLength(reference.length)
  })

  it('explains why the two genuinely un-automatable tasks are excluded', () => {
    expect(unsupportedReasonFor('chat_5')).toBeUndefined()
    expect(unsupportedReasonFor('expert_5')).toBeUndefined()
    expect(unsupportedReasonFor('black_cat')).toBeUndefined()
    expect(unsupportedReasonFor('Expert_Philanthropy')).toContain('捐款')
    expect(unsupportedReasonFor('share_invite')).toContain('邀请')
    // An unknown code still gets an honest answer rather than silence.
    expect(unsupportedReasonFor('something_new')).toContain('客户端')
  })
})

describe('WorkBuddyTaskEngine', () => {
  it('registers for tasks, reports behaviour, and claims what scored', async () => {
    await instantly(async () => {
      const tasks = [
        task('chat_5', { target: 5, current: 0, acceptStatus: 'not_accepted' }),
        task('automation_1'),
      ]
      const { client, calls } = fakeClient({
        tasks,
        onList: () => {
          // The gateway scores asynchronously; model it as "once the behavior
          // has been reported, the next read shows full progress".
          if (calls.some(call => call.startsWith('report-'))) {
            for (const entry of tasks) {
              entry.current = entry.target
              entry.claimable = true
            }
          }
        },
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['chat_5'] })
      expect(report.results.map(item => item.taskCode)).toEqual(['(报名)', 'chat_5'])
      expect(calls).toContain('accept:chat_5,automation_1')
      // Five chat reports, because the task targets five and none had scored.
      expect(calls.filter(call => call === 'report-chat')).toHaveLength(5)
      expect(calls).toContain('claim:chat_5')
      expect(report.credit).toBe(100)
      const item = report.results.find(entry => entry.taskCode === 'chat_5')
      expect(item?.progressBefore).toBe('0/5')
      expect(item?.progressAfter).toBe('5/5')
      expect(item?.message).toContain('已领奖')
    })
  })

  it('skips a task whose reward was already taken, without reporting anything', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({
        tasks: [task('RichMeow_Chat', { claimed: true, acceptStatus: 'claimed' })],
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential())
      const item = report.results.find(entry => entry.taskCode === 'RichMeow_Chat')
      expect(item?.outcome).toBe('skipped')
      expect(item?.message).toContain('已完成')
      // No accept (nothing to register) and no behavior report.
      expect(calls.filter(call => call.startsWith('report-'))).toEqual([])
      expect(calls.filter(call => call.startsWith('accept:'))).toEqual([])
    })
  })

  it('skips a task that is already at target even when unclaimed', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({
        tasks: [task('chat_5', { target: 5, current: 5 })],
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential())
      const item = report.results.find(entry => entry.taskCode === 'chat_5')
      expect(item?.outcome).toBe('skipped')
      expect(calls.filter(call => call === 'report-chat')).toEqual([])
    })
  })

  it('reports a failing action without stopping the rest', async () => {
    await instantly(async () => {
      const { client } = fakeClient({ tasks: [task('chat_5', { target: 5 }), task('automation_1')] })
      const failing: WorkBuddyTaskClient = {
        ...client,
        async reportChatActivity() { throw new Error('upstream said no') },
      }
      const engine = new WorkBuddyTaskEngine({ client: failing, list: c => client.listTasks(c) })
      const report = await engine.run(credential())
      const chat = report.results.find(entry => entry.taskCode === 'chat_5')
      expect(chat?.outcome).toBe('error')
      expect(chat?.message).toContain('upstream said no')
      // The later action still ran.
      expect(report.results.some(entry => entry.taskCode === 'automation_1')).toBe(true)
    })
  })

  it('keeps the report honest when the reward cannot be claimed', async () => {
    await instantly(async () => {
      const tasks = [task('automation_1')]
      const { client } = fakeClient({
        tasks,
        onList: () => {
          for (const entry of tasks) {
            entry.current = entry.target
            entry.claimable = true
          }
        },
      })
      const failing: WorkBuddyTaskClient = {
        ...client,
        async claimTaskReward() { throw new Error('claim rejected') },
      }
      const engine = new WorkBuddyTaskEngine({ client: failing, list: c => client.listTasks(c) })
      const report = await engine.run(credential())
      const item = report.results.find(entry => entry.taskCode === 'automation_1')
      expect(item?.outcome).toBe('done')
      expect(item?.message).toContain('领奖失败')
      expect(report.credit).toBe(0)
    })
  })


  it('drives the expert chain with real market ids and the server request id', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({
        tasks: [task('expert_5', { target: 5 })],
        experts: () => [
          { expertId: 'ex_1', expertType: 'agent', name: '专家一', profession: '文案', version: '1.0.0', category: 'expert-all' },
          { expertId: 'ex_2', expertType: 'agent', name: '专家二', profession: '设计', version: '1.0.0', category: 'expert-all' },
        ],
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['expert_5'] })
      const item = report.results.find(entry => entry.taskCode === 'expert_5')
      expect(item?.outcome).toBe('done')
      // The market was listed, because invented ids never score.
      expect(calls).toContain('expert-list:agent')
      // One real chat turn per expert, carrying that expert's own id.
      expect(calls).toContain('chat-turn:ex_1')
      expect(calls).toContain('chat-turn:ex_2')
      expect(item?.message).toContain('2 位真实专家')
    })
  })

  it('keeps going when one expert in the chain fails', async () => {
    await instantly(async () => {
      // First expert's chat is refused; the loop must move to the next one.
      let seen = 0
      const base = fakeClient({
        tasks: [task('expert_5', { target: 5 })],
        experts: () => [
          { expertId: 'ex_1', expertType: 'agent', name: '专家一', profession: '文案', version: '1.0.0', category: 'expert-all' },
          { expertId: 'ex_2', expertType: 'agent', name: '专家二', profession: '设计', version: '1.0.0', category: 'expert-all' },
        ],
      })
      const client: WorkBuddyTaskClient = {
        ...base.client,
        async desktopChatTurn(credential, turn) {
          seen += 1
          if (seen === 1) throw new Error('chat refused')
          return base.client.desktopChatTurn(credential, turn)
        },
      }
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['expert_5'] })
      const item = report.results.find(entry => entry.taskCode === 'expert_5')
      expect(item?.outcome).toBe('done')
      expect(item?.message).toContain('1 位真实专家')
    })
  })

  it('reports a wholly failed expert chain as an error', async () => {
    await instantly(async () => {
      const { client } = fakeClient({
        tasks: [task('expert_5', { target: 5 })],
        experts: () => [
          { expertId: 'ex_1', expertType: 'agent', name: '专家一', profession: '文案', version: '1.0.0', category: 'expert-all' },
        ],
        chatTurnFails: true,
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['expert_5'] })
      const item = report.results.find(entry => entry.taskCode === 'expert_5')
      expect(item?.outcome).toBe('error')
      expect(item?.message).toContain('全部失败')
    })
  })

  it('registers activity and the agreement before adopting a buddy', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({ tasks: [task('first_buddy')] })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['first_buddy'] })
      const item = report.results.find(entry => entry.taskCode === 'first_buddy')
      expect(item?.outcome).toBe('done')
      // Order matters: the adoption threshold is "active today", so the
      // activity report has to land before the agreement and the adoption.
      expect(calls.indexOf('report-chat')).toBeLessThan(calls.indexOf('buddy-agreement'))
      expect(calls.indexOf('buddy-agreement')).toBeLessThan(calls.indexOf('buddy-first'))
    })
  })

  it('sends a real glm-5.2 turn before reporting the model task', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({ tasks: [task('Model_chat_GLM5.2')] })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['Model_chat_GLM5.2'] })
      const item = report.results.find(entry => entry.taskCode === 'Model_chat_GLM5.2')
      expect(item?.outcome).toBe('done')
      expect(calls).toContain('chat-turn')
      expect(calls).toContain('report-chat')
    })
  })

  it('skips the night task outside the scoring window instead of burning turns', async () => {
    await instantly(async () => {
      const { client, calls } = fakeClient({ tasks: [task('black_cat', { target: 3 })] })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const report = await engine.run(credential(), { taskCodes: ['black_cat'] })
      const item = report.results.find(entry => entry.taskCode === 'black_cat')
      const night = new Date().getHours() >= 23 || new Date().getHours() < 8
      if (night) {
        // Inside the window the task is genuinely attempted.
        expect(calls).toContain('chat-turn')
      } else {
        // Outside it the action must NOT claim credit: "skipped" plus a reason,
        // never "done" for work that was never reported.
        expect(item?.outcome).toBe('skipped')
        expect(item?.message).toContain('23:00–08:00')
        expect(calls.filter(call => call === 'chat-turn')).toEqual([])
      }
    })
  })

  it('annotates every task with whether it can be automated', async () => {
    await instantly(async () => {
      const { client } = fakeClient({
        tasks: [task('chat_5'), task('expert_5'), task('Expert_Philanthropy'), task('something_new')],
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const view = await engine.view(credential())
      expect(view.find(entry => entry.task.taskCode === 'chat_5')?.automated).toBe(true)
      // The expert chain needs a real chat turn, but it IS drivable from here.
      expect(view.find(entry => entry.task.taskCode === 'expert_5')?.automated).toBe(true)
      expect(view.find(entry => entry.task.taskCode === 'Expert_Philanthropy')?.automated).toBe(false)
      expect(view.find(entry => entry.task.taskCode === 'Expert_Philanthropy')?.unsupportedReason).toBeDefined()
      expect(view.find(entry => entry.task.taskCode === 'something_new')?.automated).toBe(false)
    })
  })
})
describe('nextDailyRunAt', () => {
  it('returns today when the time has not passed yet', () => {
    const from = new Date(2026, 8, 18, 8, 0, 0).getTime()
    const next = nextDailyRunAt(23, 30, from)
    expect(new Date(next).getDate()).toBe(18)
    expect(new Date(next).getHours()).toBe(23)
    expect(new Date(next).getMinutes()).toBe(30)
  })

  it('returns tomorrow once the time has passed', () => {
    const from = new Date(2026, 8, 18, 23, 45, 0).getTime()
    const next = nextDailyRunAt(0, 5, from)
    expect(new Date(next).getDate()).toBe(19)
    expect(new Date(next).getHours()).toBe(0)
    expect(new Date(next).getMinutes()).toBe(5)
  })

  it('never returns the current instant', () => {
    const from = new Date(2026, 8, 18, 0, 5, 0, 0).getTime()
    expect(nextDailyRunAt(0, 5, from)).toBeGreaterThan(from)
  })

  it('clamps out-of-range times instead of producing an invalid date', () => {
    const from = new Date(2026, 8, 18, 8, 0, 0).getTime()
    const next = nextDailyRunAt(99, -5, from)
    expect(new Date(next).getHours()).toBe(23)
    expect(new Date(next).getMinutes()).toBe(0)
  })
})

describe('WorkBuddyTaskScheduler', () => {
  /** A scheduler over one domestic and one international account. */
  function makeScheduler(options: {
    tasks?: WorkBuddyTask[]
    schedule?: { enabled: boolean; hour: number; minute: number; runOnStart: boolean }
  } = {}): { scheduler: WorkBuddyTaskScheduler; runs: string[] } {
    const tasks = options.tasks ?? [task('chat_5', { target: 5 })]
    const { client } = fakeClient({ tasks })
    const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
    const runs: string[] = []
    const schedule = options.schedule ?? { enabled: false, hour: 0, minute: 5, runOnStart: false }
    const scheduler = new WorkBuddyTaskScheduler({
      engine,
      accounts: async () => [
        { credential: credential(), region: 'cn' },
        { credential: credential({ uid: 'uid-2', nickname: 'global-user', domain: 'www.workbuddy.ai' }), region: 'global' },
      ],
      schedule: () => ({ ...schedule, regions: ['cn'] }),
      accountGapMs: 0,
      log: message => { runs.push(message) },
    })
    return { scheduler, runs }
  }

  it('sweeps the domestic account and skips the international one', async () => {
    await instantly(async () => {
      const { scheduler } = makeScheduler({ tasks: [task('chat_5', { target: 5 })] })
      const reports = await scheduler.runNow()
      expect(reports.map(report => report.accountId)).toEqual(['uid-1'])
      const status = scheduler.status()
      expect(status.lastSkipped.map(entry => entry.reason)).toEqual(['国际版没有任务体系'])
      expect(status.lastRunAtMs).toBeGreaterThan(0)
      scheduler.dispose()
    })
  })

  it('runs one sweep at a time', async () => {
    await instantly(async () => {
      const { scheduler } = makeScheduler({ tasks: [task('chat_5', { target: 5 })] })
      const [first, second] = await Promise.all([scheduler.runNow(), scheduler.runNow()])
      // The second call observes the first sweep already running and returns it
      // rather than starting a parallel pass over the same accounts.
      expect(second).toBe(first)
      scheduler.dispose()
    })
  })

  it('reports the configured time and a next run only while enabled', () => {
    const armed = makeScheduler({ schedule: { enabled: true, hour: 3, minute: 15, runOnStart: false } })
    armed.scheduler.start()
    const status = armed.scheduler.status()
    expect(status.dailyAt).toBe('03:15')
    expect(status.nextRunAtMs).toBeGreaterThan(Date.now())
    armed.scheduler.dispose()

    const off = makeScheduler({ schedule: { enabled: false, hour: 3, minute: 15, runOnStart: false } })
    off.scheduler.start()
    expect(off.scheduler.status().nextRunAtMs).toBeUndefined()
    off.scheduler.dispose()
  })

  it('stops arming anything once disposed', () => {
    const { scheduler } = makeScheduler({ schedule: { enabled: true, hour: 3, minute: 15, runOnStart: true } })
    scheduler.start()
    scheduler.dispose()
    scheduler.start()
    expect(scheduler.status().nextRunAtMs).toBeUndefined()
  })
})