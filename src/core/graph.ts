/**
 * graph.ts — In-memory graph state singleton.
 * Manages nodes, links, and SSE client broadcasting.
 */

import { basename } from 'node:path'
import type { ParsedEvent, NodeType } from './parser.ts'
import { TOOL_TO_NODE_TYPE } from './parser.ts'
import type { FileDiff } from './diff.ts'

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type GraphNode = {
  id: string         // promptId for prompt nodes; `${promptId}:${toolIndex}` for children
  type: NodeType
  promptId: string
  sessionId: string
  label: string
  detail?: string    // e.g. "+12/-3 lines", "bash: git status", "subagent: Explore"
  size: number       // drives 3D sphere radius
  timestamp: number
}

export type GraphLink = {
  source: string
  target: string
  isSubagent: boolean  // true → particle animation
}

export type GraphUpdate = {
  nodes: GraphNode[]
  links: GraphLink[]
}

// ---------------------------------------------------------------------------
// Private singletons
// ---------------------------------------------------------------------------

const nodes: Map<string, GraphNode> = new Map()
const links: GraphLink[] = []
const sseClients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set()

// ---------------------------------------------------------------------------
// Node sizing constants & helpers
// ---------------------------------------------------------------------------

const BASE_SIZE = 8
const MAX_EXTRA = 40

function calcPromptSize(
  toolCallCount: number,
  subagentCount: number,
  totalLines: number,
): number {
  const raw = totalLines + toolCallCount * 3 + subagentCount * 10
  const normalized = Math.min(raw / 100, 1) // cap at 100 for normalisation
  return BASE_SIZE + normalized * MAX_EXTRA
}

function childNodeSize(type: NodeType): number {
  switch (type) {
    case 'subagent':
      return 12
    case 'bash':
      return 6
    case 'file_add':
    case 'file_modify':
    case 'file_delete':
      return 5
    case 'read':
    case 'web_search':
      return 4
    default:
      return 4
  }
}

// ---------------------------------------------------------------------------
// ingestEvent
// ---------------------------------------------------------------------------

/**
 * Ingest a parsed event + file diffs into the graph.
 * Returns only the new nodes and links added in this call.
 */
export function ingestEvent(event: ParsedEvent, diffs: FileDiff[]): GraphUpdate {
  const newNodes: GraphNode[] = []
  const newLinks: GraphLink[] = []

  const subagentCount = event.toolCalls.filter((tc) => tc.isSubagent).length

  // ------------------------------------------------------------------
  // 1. Prompt node
  // ------------------------------------------------------------------
  const promptNodeId = event.promptId
  if (!nodes.has(promptNodeId)) {
    const promptNode: GraphNode = {
      id: promptNodeId,
      type: 'prompt',
      promptId: event.promptId,
      sessionId: event.sessionId,
      label: event.userText.slice(0, 60) || event.promptId,
      size: calcPromptSize(event.toolCalls.length, subagentCount, event.totalLines),
      timestamp: event.timestamp,
    }
    nodes.set(promptNodeId, promptNode)
    newNodes.push(promptNode)
  }

  // ------------------------------------------------------------------
  // 2. Child nodes — one per tool call
  // ------------------------------------------------------------------
  for (let toolIndex = 0; toolIndex < event.toolCalls.length; toolIndex++) {
    const tc = event.toolCalls[toolIndex]
    if (!tc) continue

    const childId = `${event.promptId}:${toolIndex}`

    // Determine NodeType ---------------------------------------------------
    let nodeType: NodeType = TOOL_TO_NODE_TYPE[tc.name] ?? 'bash'

    // Refine file operation type using diffs
    if (tc.name === 'Write') {
      const filePath =
        typeof tc.input['file_path'] === 'string' ? tc.input['file_path']
        : typeof tc.input['path'] === 'string' ? tc.input['path'] : ''
      const diff = diffs.find((d) => d.path === filePath || filePath.endsWith(d.path))
      nodeType = diff?.op === 'add' ? 'file_add' : 'file_modify'
    } else if (tc.name === 'Edit' || tc.name === 'MultiEdit') {
      const filePath =
        typeof tc.input['file_path'] === 'string' ? tc.input['file_path']
        : typeof tc.input['path'] === 'string' ? tc.input['path'] : ''
      const diff = diffs.find((d) => d.path === filePath || filePath.endsWith(d.path))
      nodeType = diff?.op === 'delete' ? 'file_delete' : 'file_modify'
    }

    // Build label ----------------------------------------------------------
    let label: string
    switch (nodeType) {
      case 'file_add':
      case 'file_modify':
      case 'file_delete': {
        const filePath =
          typeof tc.input['file_path'] === 'string' ? tc.input['file_path']
          : typeof tc.input['path'] === 'string' ? tc.input['path']
          : ''
        label = filePath ? basename(filePath) : tc.name
        break
      }
      case 'bash': {
        const cmd = typeof tc.input['command'] === 'string' ? tc.input['command'] : ''
        label = cmd.slice(0, 40) || 'bash'
        break
      }
      case 'subagent': {
        label = tc.subagentType ?? 'subagent'
        break
      }
      case 'read':
      case 'web_search': {
        const pathVal =
          typeof tc.input['file_path'] === 'string' ? tc.input['file_path']
          : typeof tc.input['path'] === 'string' ? tc.input['path']
          : typeof tc.input['pattern'] === 'string' ? tc.input['pattern']
          : typeof tc.input['query'] === 'string' ? tc.input['query']
          : typeof tc.input['url'] === 'string' ? tc.input['url']
          : ''
        label = pathVal ? basename(pathVal) || pathVal.slice(0, 40) : tc.name
        break
      }
      default:
        label = tc.name
    }

    // Build detail ---------------------------------------------------------
    let detail: string | undefined
    switch (nodeType) {
      case 'file_add':
      case 'file_modify':
      case 'file_delete': {
        const filePath = typeof tc.input['path'] === 'string' ? tc.input['path']
          : typeof tc.input['file_path'] === 'string' ? tc.input['file_path'] : ''
        const diff = diffs.find((d) => d.path === filePath || filePath.endsWith(d.path))
        const diffStr = diff ? `  +${diff.additions}/-${diff.deletions}` : ''
        detail = filePath ? `${filePath}${diffStr}` : undefined
        break
      }
      case 'bash': {
        const cmd = typeof tc.input['command'] === 'string' ? tc.input['command'] : ''
        detail = cmd || undefined
        break
      }
      case 'subagent': {
        const desc =
          typeof tc.input['description'] === 'string' ? tc.input['description'] : ''
        detail = desc || tc.subagentType
        break
      }
      case 'read':
      case 'web_search': {
        const val =
          typeof tc.input['file_path'] === 'string' ? tc.input['file_path']
          : typeof tc.input['path'] === 'string' ? tc.input['path']
          : typeof tc.input['pattern'] === 'string' ? tc.input['pattern']
          : typeof tc.input['query'] === 'string' ? tc.input['query']
          : typeof tc.input['url'] === 'string' ? tc.input['url']
          : ''
        detail = val || undefined
        break
      }
      default:
        detail = undefined
    }

    const childNode: GraphNode = {
      id: childId,
      type: nodeType,
      promptId: event.promptId,
      sessionId: event.sessionId,
      label,
      detail,
      size: childNodeSize(nodeType),
      timestamp: event.timestamp,
    }

    nodes.set(childId, childNode)
    newNodes.push(childNode)

    const link: GraphLink = {
      source: childId,
      target: promptNodeId,
      isSubagent: nodeType === 'subagent',
    }
    links.push(link)
    newLinks.push(link)
  }

  // ------------------------------------------------------------------
  // 3. Broadcast and return
  // ------------------------------------------------------------------
  const update: GraphUpdate = { nodes: newNodes, links: newLinks }
  broadcastUpdate(update)
  return update
}

// ---------------------------------------------------------------------------
// getGraph
// ---------------------------------------------------------------------------

/** Return the full current graph state. */
export function getGraph(): { nodes: GraphNode[]; links: GraphLink[] } {
  return {
    nodes: Array.from(nodes.values()),
    links: [...links],
  }
}

// ---------------------------------------------------------------------------
// SSE client management
// ---------------------------------------------------------------------------

export function addSSEClient(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  sseClients.add(controller)
}

export function removeSSEClient(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  sseClients.delete(controller)
}

// ---------------------------------------------------------------------------
// broadcastUpdate
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/**
 * Broadcast a GraphUpdate to all connected SSE clients.
 * Clients that have closed are removed from the set.
 */
export function broadcastUpdate(update: GraphUpdate): void {
  if (sseClients.size === 0) return

  const payload = `data: ${JSON.stringify(update)}\n\n`
  const encoded = encoder.encode(payload)

  for (const controller of sseClients) {
    try {
      controller.enqueue(encoded)
    } catch {
      sseClients.delete(controller)
    }
  }
}
