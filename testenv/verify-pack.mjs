#!/usr/bin/env node
/**
 * Verify the PUBLISHED artifact, not the working tree.
 *
 * Two layers, deliberately separable:
 *
 * 1. **Artifact checks** — extract the tarball produced by `npm pack` and
 *    assert the manifest's promises actually hold inside it: a missing
 *    `lib/client.js`, a forgotten `cordis.patch.yml`, or an absent
 *    `./client` export all surface here instead of on a user's machine.
 *    These need nothing but Node, so CI runs them on every tag.
 * 2. **Profile wiring** — additionally link the extracted copy into a second
 *    throw-away profile inside the workspace, so it can actually be booted.
 *    This needs an installed `dsh`, which a CI runner does not have, so it is
 *    skipped (with a printed reason) when none can be located.
 *
 * Usage:  node testenv/verify-pack.mjs [tarball]
 *
 * Defaults to the newest `dist-pack/dsh-workbuddy2api-*.tgz`.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const EXTRACT = join(HERE, 'pack-extract')
const DSH_HOME = join(HERE, 'dsh-home-pack')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PLUGIN_NAME = 'dsh-workbuddy2api'
const WEB_PORT = 63951

/**
 * The installed DSH CLI, or undefined when there is none.
 *
 * Resolved from the filesystem rather than by shelling out to `where`/`which`:
 * under the DSH Windows file sandbox any spawned child with piped stdio fails
 * with EPERM, and this script must run there. A CI runner has no installed
 * `dsh` at all, which is a normal, reported outcome rather than a failure.
 */
function resolveDshInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    process.env.DSH_INSTALL_DIR,
    process.env.npm_config_prefix === undefined ? undefined : join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh'),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (candidate !== undefined && lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) return candidate
  }
  return undefined
}

/** The tarball to verify: the argument, else the newest one in dist-pack. */
function resolveTarball() {
  const explicit = process.argv[2]
  if (explicit !== undefined) return resolve(explicit)
  const dir = join(REPO, 'dist-pack')
  if (!existsSync(dir)) throw new Error(`no ${dir}; run: npm pack --pack-destination dist-pack`)
  const found = readdirSync(dir).filter(name => name.endsWith('.tgz')).sort().at(-1)
  if (found === undefined) throw new Error(`no .tgz in ${dir}; run: npm pack --pack-destination dist-pack`)
  return join(dir, found)
}

/** Replace a link or directory with a junction to `target`. */
function link(linkPath, target) {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(target)) return false
    rmSync(linkPath, { recursive: true, force: true })
  } catch {
    // absent: create below
  }
  symlinkSync(target, linkPath, 'junction')
  return true
}

/** A NUL-terminated field of a tar header block, as UTF-8 text. */
function tarField(block, start, length) {
  return block.toString('utf8', start, start + length).replace(/\u0000.*$/su, '')
}

/** Parse a pax extended-header payload into its key/value map. */
function parsePax(payload) {
  const entries = {}
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(payload.toString('utf8', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = payload.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) entries[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return entries
}

/**
 * Extract a gzipped tar archive with Node's own zlib and a minimal ustar
 * reader. Written here rather than shelled out to `tar`: the DSH Windows file
 * sandbox denies every child process with piped stdio, and this script has to
 * run there. Only the entry types npm actually emits are handled (files,
 * directories, and the pax headers npm uses for long paths).
 */
function extractTarGz(file, destination) {
  const archive = gunzipSync(readFileSync(file))
  let offset = 0
  let pax = {}
  let entries = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = Number.parseInt(tarField(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const name = tarField(header, 0, 100)
    const prefix = tarField(header, 345, 155)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const fullName = pax['path'] ?? (prefix === '' ? name : `${prefix}/${name}`)
    if (type === 'x' || type === 'g') {
      pax = parsePax(archive.subarray(dataStart, dataEnd))
    } else {
      const target = join(destination, fullName)
      if (type === '5') {
        mkdirSync(target, { recursive: true })
      } else if (type === '0' || type === '\u0000' || type === '') {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, archive.subarray(dataStart, dataEnd))
        entries += 1
      }
      pax = {}
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

const tarball = resolveTarball()
process.stdout.write(`tarball : ${tarball}\n`)

// 1. Extract the tarball without spawning anything.
rmSync(EXTRACT, { recursive: true, force: true })
mkdirSync(EXTRACT, { recursive: true })
const extracted = extractTarGz(tarball, EXTRACT)
const PACKAGE = join(EXTRACT, 'package')
process.stdout.write(`extracted ${extracted} file(s)\n`)
process.stdout.write(`package : ${PACKAGE}\n`)

// 2. Assert the manifest's promises actually hold inside the artifact.
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`) }
check('dsh.bundle.patch declared', typeof manifest.dsh?.bundle?.patch === 'string', manifest.dsh?.bundle?.patch)
check('bundle patch file ships', existsSync(join(PACKAGE, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')))
check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web')
check('exports "./client"', typeof manifest.exports?.['./client'] === 'string', manifest.exports?.['./client'])
const clientRel = manifest.exports?.['./client']
check('client bundle ships', clientRel !== undefined && existsSync(join(PACKAGE, clientRel)), clientRel)
check('main entry ships', existsSync(join(PACKAGE, manifest.main ?? 'lib/index.js')))
check('bin entry ships', existsSync(join(PACKAGE, manifest.bin?.[PLUGIN_NAME] ?? 'lib/bin.js')))
check('types ship', existsSync(join(PACKAGE, manifest.types ?? 'lib/index.d.ts')))
check('no source tree shipped', !existsSync(join(PACKAGE, 'src')))
check('no tests shipped', !existsSync(join(PACKAGE, 'tests')))

// The client bundle must be a loader-registered CJS factory, not a bare module.
if (clientRel !== undefined) {
  const bundle = readFileSync(join(PACKAGE, clientRel), 'utf8')
  check('client bundle registers with __ModuleLoader__', bundle.includes('__ModuleLoader__.load'))
  check('client bundle names the plugin id', bundle.includes(PLUGIN_NAME))

  // Exercise the shipped factory and render its registered page. Checking only
  // files/registration missed a removed host icon export that crashed in React.
  // This client needs only the host React runtime; reject any new hidden import.
  try {
    let client
    let section
    const dictionaries = new Map()
    runInNewContext(bundle, {
      window: { __ModuleLoader__: { load: ({ factory }) => {
        client = factory(id => {
          if (id === 'react') return React
          if (id === 'react/jsx-runtime') return jsxRuntime
          throw new Error(`unexpected browser runtime dependency: ${id}`)
        })
      } } },
      console,
      setTimeout: () => 0,
      clearTimeout: () => {},
      fetch: async () => ({ ok: true, json: async () => ({ writable: false }) }),
    }, { filename: clientRel })
    client.apply({
      effect: run => run(),
      get: () => undefined,
      locale: {
        register: (ns, copy) => { dictionaries.set(ns, copy.zh); return () => {} },
        bind: ns => key => dictionaries.get(ns)?.[key] ?? key,
      },
      slots: {
        inject: (name, run) => { if (name === 'settings.section') run() },
        register: (options, component) => { section = { options, component }; return () => {} },
      },
    })
    if (!section) throw new Error('settings.section was not registered')
    const html = renderToStaticMarkup(React.createElement(section.component, section.options.inject()))
    check('packed settings page renders both region tabs',
      html.includes('role="tablist"') && html.includes('国内版') && html.includes('国际版'))
  } catch (error) {
    check('packed settings page renders', false, error instanceof Error ? error.message : String(error))
  }
}

// 3. Wire a second isolated profile that uses the EXTRACTED package.
const manifestPath = join(PROFILE, 'package.json')
mkdirSync(PROFILE, { recursive: true })
writeFileSync(manifestPath, `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME], patchReload: 'live' } },
}, null, 2)}\n`)
writeFileSync(join(PROFILE, 'cordis.yml'), '# Pack-verification profile root.\n[]\n')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), `# Pack-verification profile for ${PLUGIN_NAME}.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: ${WEB_PORT}
`)
writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

const dshInstall = resolveDshInstall()
if (dshInstall === undefined) {
  process.stdout.write('\n(no installed @deepseek-ai/dsh found — profile wiring skipped; set DSH_INSTALL to enable it)\n')
  const failed = checks.filter(entry => !entry.ok)
  process.stdout.write(`${checks.length - failed.length}/${checks.length} artifact checks passed.\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
  process.exit(process.exitCode)
}

const dshPackages = join(dshInstall, 'node_modules')
const modulesDir = join(PROFILE, 'node_modules')
const scopeSrc = join(dshPackages, '@deepseek-ai')
const scopeDest = join(modulesDir, '@deepseek-ai')
mkdirSync(scopeDest, { recursive: true })
for (const name of readdirSync(scopeSrc)) link(join(scopeDest, name), join(scopeSrc, name))
for (const name of readdirSync(dshPackages)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  link(join(modulesDir, name), join(dshPackages, name))
}
link(join(modulesDir, PLUGIN_NAME), PACKAGE)

// 4. Bridge the plugin's peer closure for the extracted package too: it is a
//    real directory (not a link), so Node walks up from here and finds nothing.
const peerScope = join(EXTRACT, 'node_modules', '@deepseek-ai')
mkdirSync(peerScope, { recursive: true })
let bridged = 0
for (const name of readdirSync(scopeSrc)) {
  if (link(join(peerScope, name), join(scopeSrc, name))) bridged += 1
}
for (const name of readdirSync(dshPackages)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  if (link(join(EXTRACT, 'node_modules', name), join(dshPackages, name))) bridged += 1
}
process.stdout.write(`  bridged ${bridged} peer package(s) for the extracted copy\n`)

const failed = checks.filter(entry => !entry.ok)
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} artifact checks passed.\n`)
process.stdout.write(`\nStart the packed copy with:\n  set DSH_HOME=${DSH_HOME}\n  dsh web --no-open\n  (http://127.0.0.1:${WEB_PORT})\n`)
process.exitCode = failed.length === 0 ? 0 : 1
