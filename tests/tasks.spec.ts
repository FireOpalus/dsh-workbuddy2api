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
  it('covers the tasks that are scorable through the API alone', () => {
    const codes = automatedTaskCodes()
    for (const code of ['chat_5', 'RichMeow_Chat', 'Buddy_App', 'Buddy_App_QQ', 'automation_1',
      'Library_read', 'template_5', 'playbook_prompt', 'create_canvas', 'Hp_Appearance']) {
      expect(codes).toContain(code)
    }
  })

  it('explains why a client-only task cannot be automated', () => {
    expect(unsupportedReasonFor('chat_5')).toBeUndefined()
    expect(unsupportedReasonFor('expert_5')).toContain('专家')
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

  it('annotates every task with whether it can be automated', async () => {
    await instantly(async () => {
      const { client } = fakeClient({
        tasks: [task('chat_5'), task('expert_5'), task('something_new')],
      })
      const engine = new WorkBuddyTaskEngine({ client, list: c => client.listTasks(c) })
      const view = await engine.view(credential())
      expect(view.find(entry => entry.task.taskCode === 'chat_5')?.automated).toBe(true)
      expect(view.find(entry => entry.task.taskCode === 'expert_5')?.automated).toBe(false)
      expect(view.find(entry => entry.task.taskCode === 'expert_5')?.unsupportedReason).toBeDefined()
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
