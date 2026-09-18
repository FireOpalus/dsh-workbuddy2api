import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the real DSH home: the plugin writes a heartbeat and
 * per-account credential copies under `$DSH_HOME`, and polluting a developer's
 * real profile would make results meaningless.
 *
 * `WORKBUDDY_AUTH_FILE` is deliberately NOT set here: it is the explicit-path
 * override, and setting it would take every test down the "user pinned one
 * file" branch instead of the platform-default scanning branch.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-workbuddy2api-test-'))

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    env: { DSH_HOME: isolatedHome },
    // `threads` (worker_threads) instead of the default `forks`: the DSH
    // Windows file sandbox denies spawning any child process with piped stdio,
    // so the fork pool cannot start at all here. worker_threads communicate
    // over MessagePorts and are unaffected.
    pool: 'threads',
    // Windows runners cold-start PowerShell very slowly; `processStartTimeMs`
    // shells out to `powershell` there, so give heartbeat tests headroom.
    testTimeout: 30_000,
  },
})
