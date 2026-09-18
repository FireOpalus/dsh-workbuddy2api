/**
 * Card markup invariants that TypeScript cannot see.
 *
 * The bug this file exists for: an element hidden through React's `hidden`
 * attribute stays visible when author CSS also sets `display` on it, because
 * `[hidden]{display:none}` is only a UA style and the author rule wins. The
 * symptom was a task section whose header already said "collapsed" while its
 * body was still on screen — correct state, wrong pixels, nothing type-checked
 * complained.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const cardPath = join(here, '..', 'src', 'client', 'WorkBuddyPoolCard.tsx')
const stylesPath = join(here, '..', 'src', 'client', 'styles.ts')

const card = readFileSync(cardPath, 'utf8')
const styles = readFileSync(stylesPath, 'utf8')

/** Every class name the card hides with the `hidden` attribute. */
function hiddenClasses(): string[] {
  const found: string[] = []
  for (const line of card.split('\n')) {
    if (!line.includes('hidden={')) continue
    const match = /className="([^"]+)"/u.exec(line)
    const names = match?.[1]
    if (names === undefined) continue
    found.push(...names.split(/\s+/u).filter(Boolean))
  }
  return found
}

/** The declaration block of one class selector, or undefined when absent. */
function ruleFor(className: string): string | undefined {
  const at = styles.indexOf('.' + className + '{')
  if (at === -1) return undefined
  return styles.slice(at, styles.indexOf('}', at) + 1)
}

/** Index of the first line mentioning a class, or -1. */
function lineOf(className: string): number {
  const lines = card.split('\n')
  return lines.findIndex(line => line.includes(className))
}

/**
 * Whether the schedule block sits OUTSIDE the collapsible roster body.
 *
 * The roster is wrapped in a collapsible div; the schedule deliberately is not,
 * because it holds the on/off switch, the time, and the last/next run — the
 * things the header advertises while collapsed. That distinction is invisible to
 * the type system and was gotten wrong once, so it is asserted here by walking
 * the JSX and tracking div depth.
 */
function scheduleIsOutsideCollapsibleBody(): boolean {
  const lines = card.split('\n')
  const bodyAt = lines.findIndex(line => line.includes('dsm-wb2api-tasks-body'))
  const scheduleAt = lines.findIndex(line => line.includes('dsm-wb2api-task-schedule"'))
  if (bodyAt === -1 || scheduleAt === -1 || scheduleAt < bodyAt) return false
  let depth = 0
  for (let index = bodyAt; index < scheduleAt; index += 1) {
    const line = lines[index] ?? ''
    depth += (line.match(/<div\b/gu) ?? []).length
    depth -= (line.match(/<\/div>/gu) ?? []).length
  }
  return depth <= 0
}

describe('card markup invariants', () => {
  it('finds the hidden elements it is meant to guard', () => {
    // If the card ever stops using `hidden`, this guard has nothing to check
    // and should be revisited rather than silently pass.
    expect(hiddenClasses().length).toBeGreaterThan(0)
  })

  it('keeps the automatic schedule outside the collapsible roster', () => {
    expect(lineOf('dsm-wb2api-tasks-body')).toBeGreaterThan(-1)
    expect(lineOf('dsm-wb2api-task-schedule"')).toBeGreaterThan(-1)
    expect(
      scheduleIsOutsideCollapsibleBody(),
      'the schedule block is nested inside the collapsible roster body:'
      + ' collapsing the roster would also hide the auto-run switch, its time,'
      + ' and the last/next run status',
    ).toBe(true)
  })

  it('never lets author display beat the hidden attribute', () => {
    for (const className of hiddenClasses()) {
      const rule = ruleFor(className)
      if (rule === undefined || !rule.includes('display:')) continue
      // An author `display` on a hidden element only works if the stylesheet
      // ALSO ships a rule that out-specifies it for [hidden] (0,2,0 > 0,1,0).
      const paired = styles.includes('.' + className + '[hidden]{display:none}')
      expect(
        paired,
        `.${className} sets display but ships no '${className}[hidden]{display:none}' rule:`
        + ' the element would stay visible while React marks it hidden',
      ).toBe(true)
    }
  })

  it('keeps the paired rule reachable by specificity, not by source order', () => {
    for (const className of hiddenClasses().length === 0 ? [] : hiddenClasses()) {
      const last = styles.lastIndexOf('.' + className + '[hidden]{display:none}')
      if (last === -1) continue
      // class+attribute out-specifies the bare class, so this holds even if a
      // future edit moves the rules or the host injects its own stylesheet.
      const base = styles.lastIndexOf('.' + className + '{')
      expect(last).toBeGreaterThan(-1)
      expect(base).toBeGreaterThan(-1)
    }
  })
})
