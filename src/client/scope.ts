/**
 * The card's settings scope, over the plugin's own host route.
 *
 * Why this exists: DSH 0.1.7-rc.2 removed the browser-side `settingsScope`
 * service the card read and wrote its settings through. Re-implementing the
 * framework's form model would mean the card had two settings code paths — one
 * per DSH line — so instead the card keeps the SAME three-member interface and
 * this module satisfies it from `/plugins/dsh-workbuddy2api/config`.
 *
 * The shape is forced by the card's needs, not chosen:
 *   - `getSnapshot()` must be SYNCHRONOUS (it is called during render), so the
 *     last fetched document is cached and returned directly;
 *   - `subscribe()` therefore has to be how a change actually reaches the card,
 *     which is why every refresh notifies;
 *   - `set()` merges ONE top-level field on the host and then re-reads, so the
 *     form always shows what was actually stored rather than what was sent.
 *
 * @module dsh-workbuddy2api/client/scope
 */

/** A settings section snapshot, as the card reads it. */
export interface WorkBuddyScopeSnapshot {
  /** `ready` once a document has been read, else the failure state. */
  status: string
  /** The stored section, or undefined before the first successful read. */
  value?: unknown
  /** Whether this deployment accepts edits. */
  writable: boolean
}

/** The settings surface the pool card consumes. */
export interface WorkBuddySettingsScope {
  getSnapshot(): WorkBuddyScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** What this module needs from the page. */
export interface WorkBuddyRouteScopeOptions {
  /** The configuration route, relative to the page origin. */
  url: string
  /** Injectable for tests; defaults to the page's own fetch. */
  fetch?: typeof globalThis.fetch
}

/**
 * Build a scope over the configuration route.
 *
 * Never throws: a host that cannot answer leaves the card in its read-only state,
 * which is strictly better than the card failing to render at all.
 */
export function createRouteSettingsScope(options: WorkBuddyRouteScopeOptions): WorkBuddySettingsScope {
  const doFetch = options.fetch ?? globalThis.fetch
  let snapshot: WorkBuddyScopeSnapshot = { status: 'loading', writable: false }
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  /** Read the document and publish it. Returns the published snapshot. */
  const refresh = async (): Promise<WorkBuddyScopeSnapshot> => {
    try {
      const response = await doFetch(options.url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { value?: unknown; writable?: boolean } | undefined
      snapshot = {
        status: 'ready',
        ...body?.value === undefined ? {} : { value: body.value },
        writable: body?.writable === true,
      }
    } catch {
      // The card falls back to its read-only rendering; the host provider is
      // unaffected, which is the property that matters.
      snapshot = { status: 'error', writable: false }
    }
    emit()
    return snapshot
  }

  void refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async set(field: string, value: unknown): Promise<void> {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ field, value }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      // Re-read rather than trusting the echo: the host is the authority, and the
      // next `getSnapshot()` is what the form will render.
      await refresh()
    },
  }
}
