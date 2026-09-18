/**
 * Browser half: the WorkBuddy account-pool card inside Plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 浏览器插件的注册形态（`slots` / `locale` / `settingsScope` 三项注入、
 *     `LocaleNamespaceMap` 的模块增强、`settings.plugin.item` 槽位与
 *     `key` / `priority` 写法、以及整个 apply 体包 try/catch 以便槽位 API
 *     变更时降级为 console.error 而不触发 "Failed to load plugins" 红色横幅）
 *     来自该项目（其沿用自 dsh-connect-trae 与 dsh-workbuddy-connect）。
 * 改动：命名空间与组件名改为本插件；卡片内容改为账号池视图。
 *
 * @module dsh-workbuddy2api/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// The `slots` service declaration moved host lines: `dsh-client-runtime/client`
// owned it up to 0.1.1-rc.2, and `dsh-client-ui-renderer/client` owns it from
// the 0.1.5 line. Both are type-only side-effect imports; whichever the host
// ships supplies the augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkBuddyPoolCard } from './WorkBuddyPoolCard.tsx'
import type { WorkBuddyPoolCardInjected } from './WorkBuddyPoolCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/**
 * The browser-side plugin context this entry needs. The `slots` / `locale` /
 * `settingsScope` seats the card actually touches are declared by the client
 * subpath modules imported above, so naming the three explicitly keeps this
 * entry compilable on either host line.
 */
export type WorkBuddyClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
  settingsScope: Context['settingsScope']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy account-pool card copy. */
    'settings.workbuddy2api': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy2api-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register card copy and the pool card under Plugin configuration. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy2api'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy2api: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPoolCardInjected['t']
    const settingsScope = ctx.settingsScope.bind({ namespace: 'workbuddy2api' }) as NonNullable<WorkBuddyPoolCardInjected['settingsScope']>
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'workbuddy2api',
      priority: 30,
      inject: (): WorkBuddyPoolCardInjected => ({ t, settingsScope }),
    }, WorkBuddyPoolCard))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy2api] client card failed to load (host provider unaffected):', error)
  }
}
