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
import { createRouteSettingsScope } from './scope.ts'
import type { WorkBuddySettingsScope } from './scope.ts'
import { WORKBUDDY2API_CONFIG_PATH } from '../status-paths.ts'
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
/**
 * Client services this contribution needs.
 *
 * `settingsScope` is deliberately NOT required. DSH 0.1.7-rc.2 removed it, and a
 * required-but-absent service keeps the whole entry PENDING — which DSH reports
 * as a boot-level "Failed to load plugins / 1 entry did not activate" banner, not
 * as a merely missing card. The scope is resolved optionally below instead, and
 * the card already treats every read as possibly-absent.
 */
export const inject = ['slots', 'locale']

/** The slot lookups this entry needs, across DSH lines that changed it. */
type WorkBuddySlotsCompat = WorkBuddyClientContext['slots'] & {
  specDynamic?(key: string): unknown
  subscribeDeclaration?(key: string, listener: () => void): () => void
}

/**
 * The framework's own settings service, when this host still has one.
 *
 * Read through `ctx.get`, never as a plain property: a property read of a service
 * this entry did not inject THROWS in cordis, it does not return undefined — and
 * that throw happens before anything is registered, so the card silently vanishes.
 * The whole thing is guarded anyway, because "the host has no settings service" is
 * an ordinary state here (0.1.7+ removed it), not an error worth failing on.
 */
function legacySettingsScope(ctx: WorkBuddyClientContext): WorkBuddySettingsScope | undefined {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const service = get.call(ctx, 'settingsScope') as
      | { bind(options: { namespace: string }): WorkBuddySettingsScope }
      | undefined
    if (service === undefined || typeof service.bind !== 'function') return undefined
    return service.bind({ namespace: 'workbuddy2api' })
  } catch {
    // Present but unusable, or a proxy that still refuses the read: fall back to
    // this plugin's own configuration route.
    return undefined
  }
}

/** Register card copy and the pool card under Plugin configuration. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy2api'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy2api: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPoolCardInjected['t']
    // The settings surface, on either DSH line.
    //
    // TWO traps here, both of which cost a release:
    //   1. On 0.1.7+ the `settingsScope` SERVICE is gone, so this entry no longer
    //      requires it — a required-but-absent service leaves the entry pending,
    //      which DSH reports as a boot-level failure banner.
    //   2. But reading it anyway is not "undefined": cordis's context proxy THROWS
    //      ("cannot get property \"settingsScope\" without inject") for a service
    //      that was not injected. That throw happened before any registration, so
    //      the card never mounted and the failure looked like nothing at all.
    // `ctx.get` is the read that answers "absent" instead of throwing.
    const settingsScope: WorkBuddySettingsScope = legacySettingsScope(ctx)
      ?? createRouteSettingsScope({ url: WORKBUDDY2API_CONFIG_PATH })
    // `page` is chosen per registration: the settings page renders the card open,
    // the inline row keeps its collapsed default.
    const injected = (extra: Partial<WorkBuddyPoolCardInjected> = {}): WorkBuddyPoolCardInjected =>
      ({ t, settingsScope, ...extra })
    // 0.1.7+ replaced `settings.plugin.item` (a row inside another page's list)
    // with `settings.section` (a page of its own in the settings panel — the
    // shape this card was always meant to have).
    //
    // Registering happens on DECLARATION, and the declaration is subscribed to
    // explicitly rather than assumed.
    //
    // These slots belong to OTHER browser plugins, so at our apply time they may
    // not be declared yet. Two earlier attempts got this wrong in different ways —
    // first a synchronous existence test (answered "absent", so the card was
    // registered into a slot that never renders), then relying on `inject` to wait
    // for the declaration. Both failed SILENTLY: no card, no error, every test
    // green. So: register immediately when the slot is already there, otherwise
    // wait for the declaration, and say something if neither ever happens.
    // The slot's OWN DECLARATION is the only trustworthy signal — not a probe.
    //
    // `specDynamic('settings.section')` answers "absent" on hosts where
    // registering into it demonstrably works (dshmarket / dsh-bridge /
    // archive-manager all do exactly that, and their pages are in the sidebar).
    // Trusting that probe is what put this card into `settings.plugin.item` — a
    // row inside someone else's page, where nobody was looking for it.
    let mounted = false
    const registerSection = () => ctx.slots.register({
      name: 'settings.section',
      id: 'workbuddy2api',
      order: 60,
      label: () => t('card.pageTitle'),
      locale: namespace,
      inject: () => injected({ page: true }),
    }, WorkBuddyPoolCard)
    const registerItem = () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'workbuddy2api',
      priority: 30,
      inject: injected,
    }, WorkBuddyPoolCard)
    const mountInto = (key: 'settings.section' | 'settings.plugin.item') => {
      if (mounted) return () => {}
      mounted = true
      console.info('[dsh-workbuddy2api] settings card mounted into ' + key)
      return key === 'settings.section' ? registerSection() : registerItem()
    }
    // The card's own page wins outright.
    ctx.slots.inject('settings.section', () => mountInto('settings.section'))
    // The inline row is the fallback for hosts that only have the older slot —
    // but it waits a beat first, because a host that has BOTH (as 0.1.7-rc.2 does)
    // would otherwise put the card in the wrong place and never move it.
    ctx.slots.inject('settings.plugin.item', () => {
      const timer = setTimeout(() => { mountInto('settings.plugin.item') }, 500)
      return () => { clearTimeout(timer) }
    })
    // Doing nothing quietly is what made this take four releases to find.
    setTimeout(() => {
      if (mounted) return
      console.warn('[dsh-workbuddy2api] settings card could not mount: no settings slot was declared')
    }, 5000)
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy2api] client card failed to load (host provider unaffected):', error)
  }
}
