/**
 * Guards for DSH version compatibility.
 *
 * The outage these exist for: 0.1.7-rc.2 removed `ctx.settings.installSection`,
 * the host half still called it unguarded, and `apply` threw — which took the
 * whole plugin down and made every model disappear from DSH. A silently-missing
 * settings card is a small bug; a plugin that fails to load is an outage.
 *
 * These are deliberately source-level assertions. The behaviour they protect is
 * "which branch runs on which host", which a unit test with a faked context
 * cannot demonstrate honestly — a fake would simply implement whichever API the
 * test author had in mind.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  peerDependencies: Record<string, string>
}

describe('the host half across DSH lines', () => {
  it('never calls installSection unconditionally', () => {
    // The exact shape that broke: a bare call, outside any capability check.
    expect(SOURCE).not.toContain('ctx.settings.installSection(')
  })

  it('detects the service instead of assuming a version', () => {
    // Both branches must be present, or one DSH line is broken by definition.
    expect(SOURCE).toContain("typeof settingsService.configure === 'function'")
    expect(SOURCE).toContain("typeof settingsService.installSection === 'function'")
  })

  it('reads values back keyed by the profile entry id on the newer line', () => {
    // 0.1.7+ keys a plugin's settings by its ENTRY id, not by a name the plugin
    // invents, so both have to be tried or the live config is never found.
    expect(SOURCE).toContain('WORKBUDDY2API_ENTRY_ID')
    expect(SOURCE).toContain('describe.call(settingsService)')
  })

  it('does not cache the configuration on the newer line', () => {
    // That line reports changes as a revision, with no change callback: a cached
    // value would keep serving the configuration the user already replaced.
    expect(SOURCE).toContain('current = (): Config => {')
  })

  it('keeps the entry id in step with the patch that creates it', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const id = /id:\s*(\S+)/u.exec(patch)?.[1]
    expect(id).toBeDefined()
    expect(SOURCE).toContain(`WORKBUDDY2API_ENTRY_ID = '${id ?? ''}'`)
  })
})

describe('the declared DSH compatibility range', () => {
  const dshPeers = Object.entries(MANIFEST.peerDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis')

  it('covers every @deepseek-ai/dsh-* peer', () => {
    expect(dshPeers.length).toBeGreaterThan(5)
  })

  it('admits the 0.1.7 prerelease line on every peer', () => {
    // semver only lets a prerelease match a range when a comparator shares its
    // major.minor.patch AND carries a prerelease — so the 0.1.7 tuple must be
    // spelled out. Without it the package declares "0.1.7 unsupported" even
    // though the code runs there, which is exactly how the outage stayed hidden.
    for (const [name, range] of dshPeers) {
      expect(range, name).toContain('>=0.1.7-rc.2')
    }
  })

  it('still admits the older line it was written for', () => {
    for (const [name, range] of dshPeers) {
      expect(range, name).toContain('>=0.1.5-rc.2')
    }
  })

  it('keeps an upper bound, so a breaking 0.2 is not claimed', () => {
    for (const [name, range] of dshPeers) {
      expect(range, name).toContain('<0.2.0')
    }
  })
})

describe('the browser half across DSH lines', () => {
  const CLIENT = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

  it('does not require the removed settings scope', () => {
    // A required-but-absent service keeps the entry PENDING, which DSH reports as
    // a boot-level "Failed to load plugins" banner — far worse than a missing card.
    const inject = /export const inject = (\[[^\]]*\])/u.exec(CLIENT)?.[1] ?? ''
    expect(inject).not.toContain('settingsScope')
  })

  it('registers the page slot when the host declares it, and the old one otherwise', () => {
    // 0.1.7+ moved the card from a row inside another page to a page of its own.
    expect(CLIENT).toContain("specDynamic('settings.section')")
    expect(CLIENT).toContain("'settings.section'")
    expect(CLIENT).toContain("'settings.plugin.item'")
  })

  it('falls back to its own route when the scope service is gone', () => {
    expect(CLIENT).toContain('createRouteSettingsScope')
    expect(CLIENT).toContain('WORKBUDDY2API_CONFIG_PATH')
  })

  it('reads and writes that route instead of assuming a framework service', () => {
    const ROUTE = readFileSync(new URL('../src/web-status.ts', import.meta.url), 'utf8')
    expect(ROUTE).toContain('WORKBUDDY2API_CONFIG_PATH')
    // A merge of one field, never a whole-section replace: the wire never carries
    // secret-marked fields, so a replace would silently delete them.
    expect(ROUTE).toContain('writeConfigField')
  })
})
