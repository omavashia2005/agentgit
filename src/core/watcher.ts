import chokidar from 'chokidar'
import { statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { parseLine, groupToEvent, type RawEntry } from './parser.js'
import type { ParsedEvent } from './parser.js'

export type { ParsedEvent }

export type WatcherOptions = {
  projectsDir: string  // path to ~/.claude/projects/
  cwd: string          // current working directory to match
  onEvent: (event: ParsedEvent) => void
}

function cwdToHash(cwd: string): string {
  // /Users/foo/bar → -Users-foo-bar
  return cwd.replace(/\//g, '-')
}

const offsets = new Map<string, number>()

function readNewLines(filePath: string): string[] {
  const offset = offsets.get(filePath) ?? 0
  const stat = statSync(filePath)
  if (stat.size <= offset) return []
  const length = stat.size - offset
  const buf = Buffer.alloc(length)
  const handle = openSync(filePath, 'r')
  const bytesRead = readSync(handle, buf, 0, length, offset)
  closeSync(handle)
  offsets.set(filePath, offset + bytesRead)
  const text = buf.slice(0, bytesRead).toString('utf-8')
  return text.split('\n').filter(l => l.trim().length > 0)
}

type PromptBuffer = {
  entries: RawEntry[]
  lastSeen: number  // timestamp ms
}

export function startWatcher(opts: WatcherOptions): () => void {
  const { projectsDir, cwd, onEvent } = opts

  // 1. Derive hash from cwd
  const hash = cwdToHash(cwd)

  // 2. Find matching project directory
  let watchDir: string
  try {
    const dirs = readdirSync(projectsDir)
    const match = dirs.find(d => d === hash)
    if (match) {
      watchDir = `${projectsDir}/${match}`
    } else {
      // Fall back to watching all project directories
      watchDir = projectsDir
    }
  } catch {
    watchDir = projectsDir
  }

  // Per-file prompt buffers: filePath → Map<promptId, PromptBuffer>
  const fileBuffers = new Map<string, Map<string, PromptBuffer>>()
  // Track last seen promptId per file (for flush-on-change + assistant inheritance)
  const lastPromptId = new Map<string, string | null>()
  // Last promptId emitted by a user entry per file (assistant entries inherit this)
  const lastUserPromptId = new Map<string, string>()

  function flushBuffer(promptId: string, buffer: PromptBuffer): void {
    if (buffer.entries.length === 0) return
    const event = groupToEvent(buffer.entries)
    if (event !== null) {
      onEvent(event)
    }
  }

  function flushAllBuffers(filePath: string): void {
    const buffers = fileBuffers.get(filePath)
    if (!buffers) return
    for (const [promptId, buffer] of buffers) {
      flushBuffer(promptId, buffer)
    }
    buffers.clear()
    lastPromptId.delete(filePath)
  }

  function flushStaleBuffers(filePath: string): void {
    const buffers = fileBuffers.get(filePath)
    if (!buffers) return
    const now = Date.now()
    for (const [promptId, buffer] of buffers) {
      if (now - buffer.lastSeen > 2000) {
        flushBuffer(promptId, buffer)
        buffers.delete(promptId)
      }
    }
  }

  function processLines(filePath: string, lines: string[]): void {
    if (lines.length === 0) return

    if (!fileBuffers.has(filePath)) {
      fileBuffers.set(filePath, new Map())
    }
    const buffers = fileBuffers.get(filePath)!

    for (const line of lines) {
      const entry = parseLine(line)
      if (entry === null) continue

      let promptId: string | undefined
      if (entry.type === 'user') {
        promptId = entry.promptId
        if (promptId) lastUserPromptId.set(filePath, promptId)
      } else if (entry.type === 'assistant') {
        promptId = entry.promptId ?? lastUserPromptId.get(filePath)
      }
      if (!promptId) continue
      const prevPromptId = lastPromptId.get(filePath) ?? null

      // When promptId changes, flush previous buffer
      if (prevPromptId !== null && prevPromptId !== promptId) {
        const prevBuffer = buffers.get(prevPromptId)
        if (prevBuffer) {
          flushBuffer(prevPromptId, prevBuffer)
          buffers.delete(prevPromptId)
        }
      }

      lastPromptId.set(filePath, promptId)

      if (!buffers.has(promptId)) {
        buffers.set(promptId, { entries: [], lastSeen: Date.now() })
      }
      const buf = buffers.get(promptId)!
      buf.entries.push(entry)
      buf.lastSeen = Date.now()
    }

    // Also flush any stale buffers
    flushStaleBuffers(filePath)
  }

  // chokidar v4 doesn't support globs — watch the directory directly
  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: false,
  })

  watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return
    if (!offsets.has(filePath)) {
      offsets.set(filePath, 0)
    }
    const lines = readNewLines(filePath)
    processLines(filePath, lines)
    // Flush everything — historical data is complete at this point
    flushAllBuffers(filePath)
  })

  watcher.on('change', (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return
    const lines = readNewLines(filePath)
    processLines(filePath, lines)
  })

  return () => {
    watcher.close()
  }
}
