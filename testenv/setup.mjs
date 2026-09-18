#!/usr/bin/env node
/**
 * Materialize the workspace-local, isolated DSH test environment.
 *
 * The point of this directory is that exercising the plugin never touches the
 * developer's real `~/.dsh` profile: this script builds a throw-away
 * `$DSH_HOME` INSIDE the repository, wires the plugin into a `web` profile
 * there, and links the installed DSH packages in so the profile boots exactly
 * like the real one.
 *
 * 参考：D:\Project\DSHboost\testenv（同机同沙箱下的隔离测试环境做法）——
 *   「把 DSH_HOME 指到工作区内、用一个独立的 profile 目录、用一个不冲突的
 *   端口」这三条来自该项目；本脚本把它做成可重复执行的物化步骤。
 *
 * Usage:  node testenv/setup.mjs
 *
 * Idempotent: existing links and files are re-created in place, so running it
 * again after a rebuild is the normal workflow.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DSH_HOME = join(HERE, 'dsh-home')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PLUGIN_NAME = 'dsh-workbuddy2api'
const WEB_PORT = 63950

/**
 * The installed `dsh` CLI, whose own node_modules holds every DSH package.
 *
 * Resolved from the filesystem rather than by shelling out to `where`/`which`:
 * under the DSH Windows file sandbox any spawned child with piped stdio fails
 * with EPERM, and this script must run there. `DSH_INSTALL` wins when set, so
 * an unusual layout stays configurable without editing the script.
 */
function resolveDshInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    process.env.DSH_INSTALL_DIR,
    process.env.npm_config_prefix === undefined ? undefined : join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh'),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (candidate !== undefined && lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) return candidate
  }
  throw new Error(`cannot locate the installed @deepseek-ai/dsh; set DSH_INSTALL to its directory (tried: ${candidates.join(', ')})`)
}

const DSH_INSTALL = resolveDshInstall()
const DSH_PACKAGES = join(DSH_INSTALL, 'node_modules')

/** Replace a link or file with a junction to `target`. */
function link(linkPath, target) {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      if (resolve(dirname(linkPath), readdirLink(linkPath)) === resolve(target)) return false
      rmSync(linkPath, { recursive: true, force: true })
    } else {
      rmSync(linkPath, { recursive: true, force: true })
    }
  } catch {
    // absent: create below
  }
  symlinkSync(target, linkPath, 'junction')
  return true
}

/** Read a link target without following it to a directory listing. */
function readdirLink(linkPath) {
  return readlinkSync(linkPath)
}

/** Write `content` when the file is absent or its bytes differ. */
function writeIfChanged(path, content) {
  try {
    if (readFileSync(path, 'utf8') === content) return false
  } catch {
    // absent: write below
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return true
}

let created = 0
let unchanged = 0
const note = (changed, what) => {
  if (changed) { created += 1; process.stdout.write(`  + ${what}\n`) }
  else { unchanged += 1; process.stdout.write(`  = ${what}\n`) }
}

process.stdout.write(`dsh install: ${DSH_INSTALL}\n`)
process.stdout.write(`DSH_HOME   : ${DSH_HOME}\n`)
process.stdout.write(`profile    : ${PROFILE}\n`)

// 1. The profile manifest: the shipped web bundles plus this plugin.
const manifest = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME],
      patchReload: 'live',
    },
  },
}
note(writeIfChanged(join(PROFILE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`), 'profiles/web/package.json')

// 2. The profile's own patch layer: a loopback-only webserver on a port that
//    cannot collide with the real profile's 63877.
const patch = `# Isolated test profile for ${PLUGIN_NAME}.
# Loopback only, on a port the real profile never uses, so this environment can
# run beside the developer's live DSH without either one noticing the other.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: ${WEB_PORT}
    compression: gzip
`
note(writeIfChanged(join(PROFILE, 'cordis.patch.yml'), patch), 'profiles/web/cordis.patch.yml')
note(writeIfChanged(join(PROFILE, 'cordis.yml'), '# Test profile root — an empty entry list; the tree is composed as patches.\n[]\n'), 'profiles/web/cordis.yml')
note(writeIfChanged(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'), 'profiles/web/pnpm-workspace.yaml')

// 3. Link every DSH package the installation ships, exactly as
//    \`healProfilesModuleFallback\` would, plus this plugin from the working tree.
const modulesDir = join(PROFILE, 'node_modules')
mkdirSync(modulesDir, { recursive: true })

const scopeSrc = join(DSH_PACKAGES, '@deepseek-ai')
const scopeDest = join(modulesDir, '@deepseek-ai')
mkdirSync(scopeDest, { recursive: true })
for (const name of readdirSync(scopeSrc)) {
  note(link(join(scopeDest, name), join(scopeSrc, name)), `node_modules/@deepseek-ai/${name}`)
}
for (const name of readdirSync(DSH_PACKAGES)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  note(link(join(modulesDir, name), join(DSH_PACKAGES, name)), `node_modules/${name}`)
}
note(link(join(modulesDir, PLUGIN_NAME), REPO), `node_modules/${PLUGIN_NAME} -> ${REPO}`)

// 4. Complete the PLUGIN's own peer closure in the repository.
//
// The plugin is linked into the profile, but Node resolves its imports from the
// repository's REAL path, so the walk-up for a peer such as
// \`@deepseek-ai/dsh-launch-environment\` (a peer of dsh-llm-pi-ai, not of this
// plugin) ends at \`D:\Project\` and never reaches the installation's shared
// \`$DSH_HOME/profiles/node_modules\`. npm does not install peers of peers, so
// those packages are simply absent here and the provider fails to import.
// Linking the installation's own copies fills exactly the gaps, and ONLY the
// gaps: anything the repository installed itself keeps its pinned version.
const repoScope = join(REPO, 'node_modules', '@deepseek-ai')
mkdirSync(repoScope, { recursive: true })
let bridged = 0
for (const name of readdirSync(scopeSrc)) {
  const target = join(repoScope, name)
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue
  link(target, join(scopeSrc, name))
  bridged += 1
}
for (const name of readdirSync(DSH_PACKAGES)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  const target = join(REPO, 'node_modules', name)
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue
  link(target, join(DSH_PACKAGES, name))
  bridged += 1
}
process.stdout.write(`  bridged ${bridged} missing peer package(s) into node_modules/@deepseek-ai\n`)

process.stdout.write(`\n${created} created, ${unchanged} unchanged.\n`)
process.stdout.write(`Start it with:  ${join(HERE, 'run.cmd')}\n`)
process.stdout.write(`Or directly  :  set DSH_HOME=${DSH_HOME} && dsh web\n`)
