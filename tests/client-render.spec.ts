import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyPoolCard } from '../src/client/WorkBuddyPoolCard.tsx'
import { zh } from '../src/client/locales.ts'

// DSH 0.1.7 removed the size-suffixed icon exports. Older type declarations
// still compile them, but React rejects the undefined component at render time.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => createElement('svg'),
}))

describe('settings card rendering with the 0.1.7 icon contract', () => {
  const t = (key: keyof typeof zh) => zh[key]

  it('renders page content immediately without a host icon dependency', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyPoolCard, { t, page: true }))
    expect(html).toContain('role="tablist"')
    expect(html).toContain('国内版')
    expect(html).toContain('国际版')
    expect(html).toContain('<div class="dsm-plugin-card-body">')
    expect(html).toContain('<section class="dsm-plugin-card')
    expect(html).not.toMatch(/<button\b[^>]*class="dsm-plugin-card-header"/u)
  })

  it('still renders a collapsed legacy row', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyPoolCard, { t }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('hidden=""')
    expect(html).not.toContain('role="tablist"')
  })
})
