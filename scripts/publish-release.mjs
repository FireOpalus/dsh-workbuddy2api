#!/usr/bin/env node
/**
 * 为已推送的 tag 建 GitHub Release，并附上 `npm pack` 的 tarball。
 *
 * 参考：D:\Project\dsh-laa\.dsh-test\publish-release.mjs —— 「token 只从环境变量读、
 * 绝不打印，输出只有状态码与 URL」「Release 说明从 CHANGELOG 摘对应版本段落」
 * 「同名 asset 已存在则跳过」这三条来自该项目。
 * 改动：包名、环境变量前缀、user-agent 改为本插件；asset 类型按 npm tarball 取
 * application/gzip。
 *
 * 用法：
 *   WB2API_GH_TOKEN=<token> node scripts/publish-release.mjs v0.1.0 [tarball]
 *
 * 环境变量：
 *   WB2API_GH_TOKEN  GitHub token（repo 权限即可）；**必填**
 *   WB2API_REPO      仓库，默认 FireOpalus/dsh-workbuddy2api
 *   WB2API_TAG       标签，默认取命令行第一个参数
 *
 * 不传 tarball 时自动使用 dist-pack/ 里最新的一个。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.env.WB2API_REPO ?? 'FireOpalus/dsh-workbuddy2api'
const TOKEN = process.env.WB2API_GH_TOKEN
const TAG = process.env.WB2API_TAG ?? process.argv[2]
if (TOKEN === undefined || TOKEN === '') throw new Error('WB2API_GH_TOKEN is required (never printed)')
if (TAG === undefined || !/^v\d/.test(TAG)) throw new Error('usage: WB2API_GH_TOKEN=... node scripts/publish-release.mjs v0.1.0 [tarball]')

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

/** 命令行第二参数，或 dist-pack 里最新的 tarball。 */
function resolveAsset() {
  const explicit = process.argv[3]
  if (explicit !== undefined) return resolve(explicit)
  const dir = join(REPO_ROOT, 'dist-pack')
  if (!existsSync(dir)) throw new Error('no dist-pack/; run: npm run pack')
  const found = readdirSync(dir).filter(name => name.endsWith('.tgz')).sort().at(-1)
  if (found === undefined) throw new Error('no .tgz in dist-pack/; run: npm run pack')
  return join(dir, found)
}

/** 从 CHANGELOG 摘出这个版本的段落（到下一个 "## [" 为止）。 */
function releaseNotes() {
  const text = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8')
  const heading = `## [${TAG.replace(/^v/, '')}]`
  const start = text.indexOf(heading)
  if (start === -1) throw new Error(`CHANGELOG 里没有 ${heading}`)
  const next = text.indexOf('\n## [', start)
  return text.slice(start, next === -1 ? undefined : next).trim()
}

async function call(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'dsh-workbuddy2api-release',
      'x-github-api-version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, json, text }
}

const ASSET = resolveAsset()
console.log('repo  :', REPO)
console.log('tag   :', TAG)
console.log('asset :', basename(ASSET))

const existing = await call(`${API}/repos/${REPO}/releases/tags/${TAG}`)
let release = existing.status === 200 ? existing.json : undefined
console.log('existing release:', existing.status, release === undefined ? '(none)' : release.html_url)

if (release === undefined) {
  const created = await call(`${API}/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: TAG, body: releaseNotes(), draft: false, prerelease: false }),
  })
  console.log('create release:', created.status)
  if (created.status !== 201) {
    console.log(created.text.slice(0, 600))
    process.exit(1)
  }
  release = created.json
  console.log('created:', release.html_url, 'id', release.id, 'tag', release.tag_name)
}

const bytes = readFileSync(ASSET)
const uploaded = await call(
  `${UPLOADS}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(basename(ASSET))}`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/gzip', 'content-length': String(bytes.length) },
    body: bytes,
  },
)
if (uploaded.status !== 201) {
  if (uploaded.status === 422) console.log('asset upload:', uploaded.status, '(同名 asset 已存在，跳过)')
  else {
    console.log('asset upload:', uploaded.status)
    console.log(uploaded.text.slice(0, 600))
    process.exit(1)
  }
} else {
  console.log('asset:', uploaded.json.name, uploaded.json.size, 'bytes')
}
console.log('release page:', release.html_url)
