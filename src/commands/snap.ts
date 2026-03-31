export async function runSnap(): Promise<void> {
  try {
    const res = await fetch('http://localhost:2137/api/snap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    })
    if (!res.ok) {
      // Server responded with error — silently exit (don't disrupt Claude Code workflow)
      process.exit(0)
    }
  } catch {
    // Server not running — silently exit (don't disrupt Claude Code workflow)
    process.exit(0)
  }
}
