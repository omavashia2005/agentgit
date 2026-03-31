#!/usr/bin/env bun
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runSnap } from './commands/snap.js'

const program = new Command()
  .name('agentgit')
  .description('Visualize Claude Code agent sessions as a 3D force graph')
  .version('0.1.0')

program
  .command('init')
  .description('Set up agentgit and start the visualization server')
  .action(runInit)

program
  .command('snap')
  .description('Take a diff snapshot (called by Claude Code hooks)')
  .action(runSnap)

program.parse()
