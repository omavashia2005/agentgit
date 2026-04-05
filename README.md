# agentgit

[![npm downloads](https://img.shields.io/npm/dt/agentgit)](https://www.npmjs.com/package/agentgit)

<video src="https://github.com/user-attachments/assets/86e83e01-0074-4986-b859-74c0a5fda7c5" controls width="100%"></video>

Visualize Claude Code agent sessions as a live 3D force-directed graph in your browser.

As Claude works — writing files, running commands, spawning subagents — agentgit builds a real-time graph of everything that happened and why.

## Install

```sh
bun install -g agentgit
```


## Usage

Run this from any project directory:

```sh
agentgit init
```

This will:
1. Ask for permission to read `~/.claude/projects/` (transcript history)
2. Set up Claude Code hooks in `.claude/settings.json`
3. Start a server at `http://localhost:2137`
4. Open the 3D graph in your browser

Then just use Claude Code normally — the graph updates live.

## How it works

**Primary mode** (transcript access granted): tails the JSONL files Claude Code writes to `~/.claude/projects/` and parses tool calls, file operations, and subagent spawns as they happen.

**Fallback mode**: Claude Code hooks trigger `agentgit snap` after each Write/Edit/Bash tool use, which captures a `git diff` snapshot.

## Graph nodes

| Color | Type | Meaning |
|-------|------|---------|
| Blue | prompt | User message |
| Green | file_add | File created |
| Amber | file_modify | File modified |
| Rose | file_delete | File deleted |
| Orange | bash | Shell command |
| Gray | read | File read |
| Purple | web_search | Web search |
| Teal | subagent | Subagent spawn |

## Interactions

- **Hover** a node → inspect type, label, and details
- **Click a prompt node** → isolate and highlight its cluster
- **Click legend** → filter by node type
- **Click background** → clear selection

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Claude Code](https://claude.ai/code)
- A git repository (for diff snapshots in fallback mode)

## License

MIT
