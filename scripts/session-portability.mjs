import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const staged = `${path}.new`
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(staged, path)
}

function encodeUnit(value) {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const character = String.fromCharCode(code)
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function portableRelativePath(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.replaceAll('\\', '/')
  const marker = '/data/'
  const index = normalized.toLowerCase().indexOf(marker)
  if (index < 0) return undefined
  const relative = normalized.slice(index + marker.length)
  if (!relative.startsWith('portable-home/') && !relative.startsWith('portable-workspaces/')) return undefined
  return relative
}

function platformOfPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) return 'windows-x64'
  return undefined
}

function safeTitle(value) {
  const safe = String(value || 'workspace').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 60) || 'workspace'
}

function updateLogHeader(path, cwd) {
  const compressed = path.endsWith('.zstd')
  const bytes = readFileSync(path)
  const decoded = compressed ? zstdDecompressSync(bytes, { info: true }) : undefined
  const firstFrameBytes = compressed ? decoded.buffer : bytes
  const consumedBytes = compressed ? decoded.engine.bytesWritten : bytes.length
  const text = firstFrameBytes.toString('utf8')
  const newline = text.indexOf('\n')
  const first = newline < 0 ? text : text.slice(0, newline)
  const header = JSON.parse(first)
  if (header.type !== 'session' || header.cwd === cwd) return
  const backup = `${path}.portable-backup`
  if (!existsSync(backup)) copyFileSync(path, backup)
  header.cwd = cwd
  const updated = `${JSON.stringify(header)}${newline < 0 ? '' : text.slice(newline)}`
  const staged = `${path}.new`
  const replacement = compressed ? zstdCompressSync(Buffer.from(updated)) : Buffer.from(updated)
  writeFileSync(staged, compressed ? Buffer.concat([replacement, bytes.subarray(consumedBytes)]) : replacement)
  renameSync(staged, path)
}

function migrateProjectSessions(sessionsRoot, oldCwd, newCwd) {
  if (oldCwd === newCwd || !existsSync(sessionsRoot)) return
  const source = join(sessionsRoot, projectKey(oldCwd))
  if (!existsSync(source)) return
  const destination = join(sessionsRoot, projectKey(newCwd))
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sessionDirectory = join(source, entry.name)
    for (const file of readdirSync(sessionDirectory)) {
      if (/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(file)) updateLogHeader(join(sessionDirectory, file), newCwd)
    }
    const targetDirectory = join(destination, encodeUnit(entry.name))
    if (existsSync(targetDirectory)) {
      if (resolve(targetDirectory) !== resolve(sessionDirectory)) throw new Error(`portable session destination already exists: ${targetDirectory}`)
    } else {
      renameSync(sessionDirectory, targetDirectory)
    }
  }
  if (readdirSync(source).length === 0) rmSync(source, { recursive: true })
}

function migrateNamedSession(sessionsRoot, sessionId, cwd) {
  if (!existsSync(sessionsRoot)) return false
  let source
  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, encodeUnit(sessionId))
    if (existsSync(candidate)) {
      source = candidate
      break
    }
  }
  if (!source) return false
  for (const file of readdirSync(source)) {
    if (/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(file)) updateLogHeader(join(source, file), cwd)
  }
  const destinationProject = join(sessionsRoot, projectKey(cwd))
  const destination = join(destinationProject, basename(source))
  if (resolve(source) === resolve(destination)) return true
  mkdirSync(destinationProject, { recursive: true })
  if (existsSync(destination)) throw new Error(`portable session destination already exists: ${destination}`)
  const sourceProject = resolve(source, '..')
  renameSync(source, destination)
  if (readdirSync(sourceProject).length === 0) rmSync(sourceProject, { recursive: true })
  return true
}

function chooseWorkspacePath(root, target, id, workspace, map) {
  const relative = portableRelativePath(workspace.path)
  if (relative) return join(root, 'data', ...relative.split('/'))

  const inferredPlatform = platformOfPath(workspace.path)
  if (inferredPlatform) map.paths[inferredPlatform] ??= workspace.path
  else if (existsSync(workspace.path)) map.paths[target] = workspace.path

  const remembered = map.paths[target]
  if (remembered && existsSync(remembered)) return remembered
  return join(root, 'data', 'portable-workspaces', `${id}-${safeTitle(workspace.title)}`)
}

export function migratePortableSessions({ root, target, dshHome, log = () => {} }) {
  const workspacePath = join(dshHome, 'storages', 'workspace.json')
  if (!existsSync(workspacePath)) return { workspaces: 0, sessions: 0 }
  const registry = readJson(workspacePath)
  const workspaces = registry.tables?.workspaces
  if (!workspaces) return { workspaces: 0, sessions: 0 }

  const mappingPath = join(dshHome, 'portable-workspace-paths.json')
  let mappings = { schema: 1, workspaces: {} }
  try { mappings = readJson(mappingPath) } catch {}
  mappings.schema = 1
  mappings.workspaces ??= {}

  const changes = new Map()
  for (const [id, workspace] of Object.entries(workspaces)) {
    const map = mappings.workspaces[id] ??= { title: workspace.title, paths: {} }
    map.title = workspace.title
    map.paths ??= {}
    const oldPath = workspace.path
    const newPath = chooseWorkspacePath(root, target, id, workspace, map)
    mkdirSync(newPath, { recursive: true })
    if (oldPath !== newPath) {
      changes.set(oldPath, newPath)
      workspace.path = newPath
    }
  }

  const sessionsRoot = join(dshHome, 'sessions')
  for (const [oldPath, newPath] of changes) migrateProjectSessions(sessionsRoot, oldPath, newPath)
  for (const workspace of Object.values(workspaces)) {
    for (const sessionId of workspace.sessionIds ?? []) migrateNamedSession(sessionsRoot, sessionId, workspace.path)
  }

  let sessionChanges = 0
  const cache = join(dshHome, 'storages', 'session_projcache', 'sessions')
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(cache, entry.name)
      let document
      try { document = readJson(path) } catch { continue }
      const identity = document.record?.identity
      const relocated = identity?.cwd ? changes.get(identity.cwd) : undefined
      if (relocated) {
        identity.cwd = relocated
        writeJson(path, document)
        sessionChanges += 1
      }
    }
  }

  if (changes.size) {
    writeJson(workspacePath, registry)
    log(`made ${changes.size} workspace and ${sessionChanges} chat session(s) portable for ${target}`)
  }
  writeJson(mappingPath, mappings)
  return { workspaces: changes.size, sessions: sessionChanges }
}
