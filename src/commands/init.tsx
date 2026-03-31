import { useState, useEffect } from 'react'
import { render, Box, Text } from 'ink'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { Header } from '../components/Header.js'
import { Step } from '../components/Step.js'
import { Confirm } from '../components/Confirm.js'
import { startServer } from '../core/server.js'
import { startWatcher } from '../core/watcher.js'
import { ingestEvent } from '../core/graph.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepKey = 'access' | 'dotclaude' | 'settings' | 'dotAgentgit' | 'server' | 'browser'
type StepStatus = 'pending' | 'running' | 'done' | 'error'
type StepState = { status: StepStatus; detail?: string }
type Steps = Record<StepKey, StepState>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTGIT_DIR = join(homedir(), '.agentgit')
const CONFIG_PATH = join(AGENTGIT_DIR, 'config.json')
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

interface Config {
  grantedAccess: boolean
  hookCommand: string
}

function buildHookCommand(): string {
  const entrypoint = process.argv[1] ?? ''
  const isFromSource = entrypoint.endsWith('src/index.ts') || entrypoint.endsWith('src/index.js')
  if (isFromSource) {
    return `${process.execPath} ${entrypoint} snap`
  }
  return 'agentgit snap'
}

async function readConfig(): Promise<Config | null> {
  try {
    const file = Bun.file(CONFIG_PATH)
    const exists = await file.exists()
    if (!exists) return null
    return (await file.json()) as Config
  } catch {
    return null
  }
}

async function writeConfig(config: Config): Promise<void> {
  if (!existsSync(AGENTGIT_DIR)) {
    mkdirSync(AGENTGIT_DIR, { recursive: true })
  }
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2))
}

async function ensureDotClaude(): Promise<'created' | 'exists'> {
  const dir = join(process.cwd(), '.claude')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return 'created'
  }
  return 'exists'
}

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: Array<{
      matcher: string
      hooks: Array<{ type: string; command: string }>
    }>
  }
  [key: string]: unknown
}

async function ensureClaudeSettings(hookCommand: string): Promise<'created' | 'merged' | 'skipped'> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json')
  const file = Bun.file(settingsPath)
  const exists = await file.exists()

  const newEntry = {
    matcher: 'Write|Edit|MultiEdit|Bash',
    hooks: [{ type: 'command', command: hookCommand }],
  }

  if (!exists) {
    const settings: ClaudeSettings = {
      hooks: {
        PostToolUse: [newEntry],
      },
    }
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2))
    return 'created'
  }

  // File exists — merge
  let settings: ClaudeSettings
  try {
    settings = (await file.json()) as ClaudeSettings
  } catch {
    settings = {}
  }

  if (!settings.hooks) {
    settings.hooks = {}
  }
  if (!settings.hooks.PostToolUse) {
    settings.hooks.PostToolUse = []
  }

  // Idempotency check: skip if agentgit hook already present
  const alreadyPresent = settings.hooks.PostToolUse.some((entry) =>
    entry.hooks?.some(
      (h) => typeof h.command === 'string' && h.command.includes('agentgit'),
    ),
  )

  if (alreadyPresent) {
    return 'skipped'
  }

  settings.hooks.PostToolUse.push(newEntry)
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2))
  return 'merged'
}

async function ensureDotAgentgit(): Promise<'created' | 'exists'> {
  const dir = join(process.cwd(), '.agentgit')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return 'created'
  }
  return 'exists'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<StepKey, string> = {
  access: 'Grant Claude projects access',
  dotclaude: 'Check .claude/ directory',
  settings: 'Configure .claude/settings.json hooks',
  dotAgentgit: 'Create .agentgit/ directory',
  server: 'Start server on port 2137',
  browser: 'Open browser',
}

const PENDING: StepState = { status: 'pending' }

function InitApp() {
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null)
  const [grantedAccess, setGrantedAccess] = useState<boolean | null>(null)
  const [confirmDone, setConfirmDone] = useState(false)
  const [steps, setSteps] = useState<Steps>({
    access: PENDING,
    dotclaude: PENDING,
    settings: PENDING,
    dotAgentgit: PENDING,
    server: PENDING,
    browser: PENDING,
  })
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [allDone, setAllDone] = useState(false)

  function setStep(key: StepKey, state: StepState) {
    setSteps((prev) => ({ ...prev, [key]: state }))
  }

  // Detect first run on mount
  useEffect(() => {
    readConfig().then((config) => {
      if (config === null) {
        setIsFirstRun(true)
      } else {
        setIsFirstRun(false)
        setGrantedAccess(config.grantedAccess)
        setConfirmDone(true)
      }
    })
  }, [])

  // Once we know confirmation answer (either from Confirm component or loaded
  // from config), run the setup steps.
  useEffect(() => {
    if (!confirmDone || grantedAccess === null || isFirstRun === null) return

    const hookCommand = buildHookCommand()

    async function run() {
      // --- Step: access (first run only — write config) ---
      if (isFirstRun) {
        setStep('access', { status: 'running' })
        try {
          await writeConfig({ grantedAccess: grantedAccess!, hookCommand })
          setStep('access', {
            status: 'done',
            detail: grantedAccess ? 'access granted' : 'access denied',
          })
        } catch (err) {
          setStep('access', { status: 'error', detail: String(err) })
          return
        }
      } else {
        setStep('access', {
          status: 'done',
          detail: grantedAccess ? 'access granted (from config)' : 'access denied (from config)',
        })
      }

      // --- Step: dotclaude ---
      setStep('dotclaude', { status: 'running' })
      try {
        const result = await ensureDotClaude()
        setStep('dotclaude', {
          status: 'done',
          detail: result === 'created' ? 'created' : 'already exists',
        })
      } catch (err) {
        setStep('dotclaude', { status: 'error', detail: String(err) })
        return
      }

      // --- Step: settings ---
      setStep('settings', { status: 'running' })
      try {
        const result = await ensureClaudeSettings(hookCommand)
        setStep('settings', {
          status: 'done',
          detail:
            result === 'created'
              ? 'created with hooks'
              : result === 'merged'
                ? 'hooks merged'
                : 'hooks already present',
        })
      } catch (err) {
        setStep('settings', { status: 'error', detail: String(err) })
        return
      }

      // --- Step: dotAgentgit ---
      setStep('dotAgentgit', { status: 'running' })
      try {
        const result = await ensureDotAgentgit()
        setStep('dotAgentgit', {
          status: 'done',
          detail: result === 'created' ? 'created' : 'already exists',
        })
      } catch (err) {
        setStep('dotAgentgit', { status: 'error', detail: String(err) })
        return
      }

      // --- Step: server ---
      setStep('server', { status: 'running' })
      try {
        startServer(2137)
        setServerUrl('http://localhost:2137')
        setStep('server', { status: 'done', detail: 'http://localhost:2137' })
      } catch (err) {
        setStep('server', { status: 'error', detail: String(err) })
        return
      }

      // --- Step: watcher (conditional, non-blocking) ---
      if (grantedAccess) {
        try {
          startWatcher({
            projectsDir: CLAUDE_PROJECTS_DIR,
            cwd: process.cwd(),
            onEvent: (event) => {
              ingestEvent(event, [])
            },
          })
        } catch {
          // watcher failure is non-fatal
        }
      }

      // --- Step: browser ---
      setStep('browser', { status: 'running' })
      try {
        Bun.spawn(['open', 'http://localhost:2137'])
        setStep('browser', { status: 'done', detail: 'opened' })
      } catch (err) {
        // Opening the browser is best-effort
        setStep('browser', { status: 'error', detail: String(err) })
      }

      setAllDone(true)
    }

    run()
  }, [confirmDone, grantedAccess, isFirstRun])

  // Handle confirm answer from Confirm component
  function handleConfirm(answer: boolean) {
    setGrantedAccess(answer)
    setConfirmDone(true)
  }

  // Still determining first-run state
  if (isFirstRun === null) {
    return <Text dimColor>Loading...</Text>
  }

  const stepKeys: StepKey[] = ['dotclaude', 'settings', 'dotAgentgit', 'server', 'browser']

  return (
    <Box flexDirection="column" paddingY={1}>
      {isFirstRun && <Header />}

      {isFirstRun && !confirmDone && (
        <Box marginBottom={1}>
          <Confirm
            question="Grant read access to ~/.claude/projects/?"
            onConfirm={handleConfirm}
          />
        </Box>
      )}

      {isFirstRun && confirmDone && (
        <Box marginBottom={1}>
          <Step
            label={STEP_LABELS.access}
            status={steps.access.status}
            detail={steps.access.detail}
          />
        </Box>
      )}

      {confirmDone && (
        <Box flexDirection="column">
          {stepKeys.map((key) => (
            <Step
              key={key}
              label={STEP_LABELS[key]}
              status={steps[key].status}
              detail={steps[key].detail}
            />
          ))}
        </Box>
      )}

      {allDone && serverUrl && (
        <Box marginTop={1}>
          <Text color="cyan">Server running at </Text>
          <Text color="cyan" bold>
            {serverUrl}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function runInit(): void {
  render(<InitApp />)
}
