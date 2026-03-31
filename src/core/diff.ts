export type FileDiff = {
  path: string
  additions: number
  deletions: number
  op: 'add' | 'modify' | 'delete'
}

export function parseDiffOutput(raw: string): FileDiff[] {
  const results: FileDiff[] = []

  let current: FileDiff | null = null

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) {
        results.push(current)
      }
      // Extract path from b/ part: "diff --git a/foo/bar b/foo/bar"
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
      const path = (match ? match[1] : undefined) ?? line.slice('diff --git a/'.length)
      current = { path, additions: 0, deletions: 0, op: 'modify' }
      continue
    }

    if (current === null) continue

    if (line.startsWith('new file mode')) {
      current.op = 'add'
      continue
    }

    if (line.startsWith('deleted file mode')) {
      current.op = 'delete'
      continue
    }

    if (line.startsWith('+++ /dev/null')) {
      current.op = 'delete'
      continue
    }

    if (line.startsWith('--- /dev/null')) {
      current.op = 'add'
      continue
    }

    // Count added lines (but not the +++ header line)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++
      continue
    }

    // Count deleted lines (but not the --- header line)
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++
      continue
    }
  }

  if (current !== null) {
    results.push(current)
  }

  return results
}

export async function getDiff(cwd: string): Promise<FileDiff[]> {
  const proc = Bun.spawn(['git', 'diff', 'HEAD'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return parseDiffOutput(text)
}

export async function getStagedDiff(cwd: string): Promise<FileDiff[]> {
  const proc = Bun.spawn(['git', 'diff', '--cached'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return parseDiffOutput(text)
}
