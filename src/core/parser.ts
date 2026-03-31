/**
 * parser.ts — Pure data transformation, no I/O.
 * Parses raw JSONL lines from Claude Code session transcripts into typed events
 * grouped by promptId.
 */

// ---------------------------------------------------------------------------
// Node / tool types
// ---------------------------------------------------------------------------

export type NodeType =
  | 'prompt'
  | 'file_add'
  | 'file_modify'
  | 'file_delete'
  | 'bash'
  | 'read'
  | 'web_search'
  | 'subagent'

export const TOOL_TO_NODE_TYPE: Record<string, NodeType> = {
  Write: 'file_add',      // graph.ts will check diffs to distinguish add vs modify
  Edit: 'file_modify',
  MultiEdit: 'file_modify',
  Read: 'read',
  Bash: 'bash',
  WebSearch: 'web_search',
  WebFetch: 'web_search',
  Agent: 'subagent',
  Glob: 'read',
  Grep: 'read',
}

// ---------------------------------------------------------------------------
// Raw entry types (matching the JSONL schema)
// ---------------------------------------------------------------------------

type TextContent = { type: 'text'; text: string }
type ToolResultContent = { type: 'tool_result'; tool_use_id: string; content: unknown }
type ThinkingContent = { type: 'thinking'; thinking: string }
type ToolUseContent = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  caller: { type: string }
}

type UserMessageContent = TextContent | ToolResultContent
type AssistantMessageContent = ThinkingContent | ToolUseContent | TextContent

export type RawEntryQueueOperation = {
  type: 'queue-operation'
  operation: 'enqueue' | 'dequeue'
  timestamp: string
  sessionId: string
}

export type RawEntryUser = {
  type: 'user'
  uuid: string
  parentUuid: string | null
  promptId: string
  sessionId: string
  timestamp: string
  isSidechain: boolean
  message: {
    role: 'user'
    content: UserMessageContent[]
  }
  toolUseResult?: {
    agentId?: string
    agentType?: string
    content?: unknown[]
  }
  cwd: string
  gitBranch?: string
}

export type RawEntryAssistant = {
  type: 'assistant'
  uuid: string
  parentUuid: string
  promptId?: string
  sessionId: string
  timestamp: string
  message: {
    role: 'assistant'
    content: AssistantMessageContent[]
    stop_reason?: string
  }
  requestId: string
  cwd: string
}

export type RawEntryFileHistorySnapshot = {
  type: 'file-history-snapshot'
  messageId: string
  snapshot: {
    messageId: string
    trackedFileBackups: Record<string, unknown>
    timestamp: string
  }
  isSnapshotUpdate: boolean
}

export type RawEntryAiTitle = {
  type: 'ai-title'
  sessionId: string
  aiTitle: string
}

export type RawEntry =
  | RawEntryQueueOperation
  | RawEntryUser
  | RawEntryAssistant
  | RawEntryFileHistorySnapshot
  | RawEntryAiTitle

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ToolCall = {
  name: string
  input: Record<string, unknown>
  isSubagent: boolean
  subagentType?: string
}

export type ParsedEvent = {
  promptId: string
  sessionId: string
  timestamp: number   // ms since epoch
  userText: string    // first user text content in this turn
  toolCalls: ToolCall[]
  totalLines: number  // set by caller; initialised to 0
}

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line into a RawEntry, or null if the line is empty,
 * malformed, or carries an unrecognised type.
 */
export function parseLine(line: string): RawEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  const entryType = obj['type']

  switch (entryType) {
    case 'queue-operation':
    case 'user':
    case 'assistant':
    case 'file-history-snapshot':
    case 'ai-title':
      return obj as unknown as RawEntry
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// groupToEvent
// ---------------------------------------------------------------------------

/**
 * Given an array of raw entries all sharing the same promptId, produce a
 * ParsedEvent.  Returns null if the group carries no useful data.
 */
export function groupToEvent(entries: RawEntry[]): ParsedEvent | null {
  // We need at least one user entry to establish promptId / sessionId
  const userEntries = entries.filter((e): e is RawEntryUser => e.type === 'user')
  const assistantEntries = entries.filter(
    (e): e is RawEntryAssistant => e.type === 'assistant',
  )

  if (userEntries.length === 0 && assistantEntries.length === 0) return null

  // Derive promptId / sessionId from the first user entry (fallback: assistant)
  const primaryUser = userEntries[0]
  const primaryAssistant = assistantEntries[0]

  const promptId: string =
    primaryUser?.promptId ??
    primaryAssistant?.promptId ??
    ''

  if (!promptId) return null

  const sessionId: string =
    primaryUser?.sessionId ??
    primaryAssistant?.sessionId ??
    ''

  // Earliest timestamp across all entries
  const allTimestamps = entries
    .map((e) => {
      const ts = (e as Record<string, unknown>)['timestamp']
      if (typeof ts === 'string') return Date.parse(ts)
      return NaN
    })
    .filter((t) => !isNaN(t))

  const timestamp = allTimestamps.length > 0 ? Math.min(...allTimestamps) : 0

  // Extract the first plain-text string from user message content
  let userText = ''
  for (const ue of userEntries) {
    if (!Array.isArray(ue.message?.content)) continue
    for (const item of ue.message.content) {
      if (item.type === 'text' && item.text) {
        userText = item.text
        break
      }
    }
    if (userText) break
  }

  // Collect all tool_use entries from assistant messages
  const toolCalls: ToolCall[] = []
  for (const ae of assistantEntries) {
    if (!Array.isArray(ae.message?.content)) continue
    for (const item of ae.message.content) {
      if (item.type !== 'tool_use') continue

      const toolUse = item as ToolUseContent
      const isSubagent = toolUse.name === 'Agent'

      // Determine subagentType from the tool_use_result in subsequent user entry
      // (best-effort: look for toolUseResult.agentType in any user entry)
      let subagentType: string | undefined
      if (isSubagent) {
        for (const ue of userEntries) {
          if (ue.toolUseResult?.agentType) {
            subagentType = ue.toolUseResult.agentType
            break
          }
        }
      }

      toolCalls.push({
        name: toolUse.name,
        input: toolUse.input,
        isSubagent,
        subagentType,
      })
    }
  }

  return {
    promptId,
    sessionId,
    timestamp,
    userText,
    toolCalls,
    totalLines: 0,
  }
}

// ---------------------------------------------------------------------------
// parseLines
// ---------------------------------------------------------------------------

/**
 * Parse a stream of JSONL lines into completed ParsedEvents.
 * Entries without a promptId (queue-operation, ai-title, file-history-snapshot)
 * are skipped for grouping purposes.
 * Events are returned in ascending timestamp order.
 */
export function parseLines(lines: string[]): ParsedEvent[] {
  // Group raw entries by promptId, preserving insertion order
  const groups = new Map<string, RawEntry[]>()
  let lastPromptId: string | undefined

  for (const line of lines) {
    const entry = parseLine(line)
    if (!entry) continue

    let promptId: string | undefined

    if (entry.type === 'user') {
      promptId = entry.promptId
      lastPromptId = promptId
    } else if (entry.type === 'assistant') {
      // Assistant entries rarely carry a promptId — inherit from the last user entry
      promptId = entry.promptId ?? lastPromptId
    }
    // queue-operation, ai-title, file-history-snapshot → skip

    if (!promptId) continue

    let group = groups.get(promptId)
    if (!group) {
      group = []
      groups.set(promptId, group)
    }
    group.push(entry)
  }

  const events: ParsedEvent[] = []
  for (const [, group] of groups) {
    const event = groupToEvent(group)
    if (event) events.push(event)
  }

  // Sort by timestamp ascending
  events.sort((a, b) => a.timestamp - b.timestamp)

  return events
}
