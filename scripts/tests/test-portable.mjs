import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { migratePortableSessions, projectKey } from '../session-portability.mjs'

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(scripts, '..')
const rootFiles = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()
assert.deepEqual(rootFiles, ['linux.sh', 'mac.sh', 'windows.bat'])
const manifest = JSON.parse(readFileSync(join(scripts, 'manifest.json'), 'utf8'))
assert.equal(manifest.deepseekHarness.package, '@deepseek-ai/dsh')
assert.match(manifest.deepseekHarness.version, /^\d+\.\d+\.\d+(?:-(?:alpha|rc)\.\d+)?$/)
assert.match(manifest.deepseekHarness.updateChannel, /^(?:latest|next|alpha)$/)
assert.equal(manifest.release.autoUpdateHours, 24)
assert.deepEqual(Object.keys(manifest.node).filter(key => key.includes('-')).sort(), ['linux-x64', 'macos-arm64', 'windows-x64'])
for (const target of ['linux-x64', 'macos-arm64', 'windows-x64']) assert.match(manifest.node[target].sha256, /^[0-9a-f]{64}$/)

const fixture = mkdtempSync(join(tmpdir(), 'dsh-portable-session-'))
try {
  const dshHome = join(fixture, 'data', 'dsh-home')
  const oldRoot = 'C:\\Users\\Test User\\Deepseek-Harness-Portable'
  const oldCwd = `${oldRoot}\\data\\portable-home\\Documents\\deepseek-harness\\default-workspace`
  const sessionId = 'session-portability-test'
  const workspaceId = 'workspace-portability-test'
  const registryPath = join(dshHome, 'storages', 'workspace.json')
  mkdirSync(dirname(registryPath), { recursive: true })
  writeFileSync(registryPath, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: [workspaceId], defaultWorkspaceId: workspaceId },
    tables: { workspaces: { [workspaceId]: { path: oldCwd, title: 'default-workspace', sessionIds: [sessionId] } } },
  }))
  const cachePath = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({ version: 7, record: { identity: { cwd: oldCwd } } }))
  const logPath = join(dshHome, 'sessions', projectKey(oldCwd), sessionId, 'session.v4.jsonl.zstd')
  mkdirSync(dirname(logPath), { recursive: true })
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd: oldCwd })}\n`))
  const eventFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } })}\n`))
  writeFileSync(logPath, Buffer.concat([headerFrame, eventFrame]))

  const result = migratePortableSessions({ root: fixture, target: 'macos-arm64', dshHome })
  const expectedCwd = join(fixture, 'data', 'portable-home', 'Documents', 'deepseek-harness', 'default-workspace')
  assert.deepEqual(result, { workspaces: 1, sessions: 1 })
  assert.equal(JSON.parse(readFileSync(registryPath, 'utf8')).tables.workspaces[workspaceId].path, expectedCwd)
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).record.identity.cwd, expectedCwd)
  const migratedLog = join(dshHome, 'sessions', projectKey(expectedCwd), sessionId, 'session.v4.jsonl.zstd')
  const migratedBytes = readFileSync(migratedLog)
  const migratedHeader = zstdDecompressSync(migratedBytes, { info: true })
  assert.equal(JSON.parse(migratedHeader.buffer.toString('utf8').trim()).cwd, expectedCwd)
  assert.deepEqual(migratedBytes.subarray(migratedHeader.engine.bytesWritten), eventFrame)
  assert.equal(existsSync(join(dshHome, 'sessions', projectKey(oldCwd))), false)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log('portable contract tests passed')
