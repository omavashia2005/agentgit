/**
 * server.ts — HTTP server for the agentgit project.
 * Serves the frontend and exposes graph, SSE, and snap-hook API routes.
 */

import { join } from 'node:path'
import { getGraph, addSSEClient, removeSSEClient, ingestEvent } from './graph.js'
import { getDiff } from './diff.js'
import type { ParsedEvent } from './parser.js'

export function startServer(port: number = 2137): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    routes: {
      '/': {
        GET: async () => {
          const file = Bun.file(join(import.meta.dir, '../../public/index.html'))
          const text = await file.text()
          return new Response(text, {
            headers: { 'Content-Type': 'text/html' },
          })
        },
      },

      '/api/graph': {
        GET: () => {
          const graph = getGraph()
          return new Response(JSON.stringify(graph), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
      },

      '/api/live': {
        GET: () => {
          const enc = new TextEncoder()
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              addSSEClient(controller)
              controller.enqueue(enc.encode('data: {"type":"connected"}\n\n'))
            },
            cancel(controller) {
              removeSSEClient(controller as ReadableStreamDefaultController<Uint8Array>)
            },
          })
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            },
          })
        },
      },

      '/api/snap': {
        POST: async (req: Request) => {
          const body = (await req.json()) as { cwd?: string }
          const cwd = body.cwd ?? process.cwd()

          const event: ParsedEvent = {
            promptId: `snap-${Date.now()}`,
            sessionId: 'snap',
            timestamp: Date.now(),
            userText: 'hook snap',
            toolCalls: [{ name: 'Bash', input: { command: 'snap hook' }, isSubagent: false }],
            totalLines: 0,
          }

          const diffs = await getDiff(cwd)
          ingestEvent(event, diffs)

          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
      },
    },

    fetch(req: Request) {
      return new Response('Not found', { status: 404 })
    },
  })

  return server
}
