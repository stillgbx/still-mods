// The git status line under the prompt: the branch, the changed and new files, and how far the
// branch is ahead of or behind its upstream. Read from `git status --porcelain=v1 -b` in the session's
// folder, at start, after each call that may change the tree, and every few seconds.
import type { EngineInterface, Register } from 'claude-code'

import { type Locale, resolveLocale, systemLocale } from './i18n'

const POLL_MS = 15_000
// a burst of edits refreshes once, this long after the last
const SETTLE_MS = 800
const TREE_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

let locale: Locale = 'en'
let language = 'auto'
let shown: string | undefined
let pending: { cancel(): void } | null = null

const TEXT = {
  en: {
    changed: (n: number) => `${n} changed`,
    added: (n: number) => `${n} new`,
    clean: 'clean',
    local: 'no upstream',
    detached: 'detached',
  },
  fr: {
    changed: (n: number) => `${n} modifié${n === 1 ? '' : 's'}`,
    added: (n: number) => `${n} nouveau${n === 1 ? '' : 'x'}`,
    clean: 'propre',
    local: 'sans suivi',
    detached: 'détachée',
  },
}

export function registerGitStatus(on: Parameters<Register>[0], options: { language?: string }) {
  language = options.language ?? 'auto'

  // a matcher, so other features may hook session.start too
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const settings = await $.settings.read()
    locale = resolveLocale(language, settings.language, systemLocale())
    await refresh($)
    $.clock.every(POLL_MS, () => refresh($))
    return next(e)
  })

  on('tool.call', { tool: TREE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    pending?.cancel()
    pending = $.clock.after(SETTLE_MS, () => {
      pending = null
      void refresh($)
    })
    return ran
  })
}

async function refresh($: EngineInterface) {
  let text: string | undefined
  try {
    const run = await $.process.run(['git', 'status', '--porcelain=v1', '-b'], { timeoutMs: 5000 })
    text = run.exitCode === 0 ? describe(run.stdout) : undefined
  } catch {
    text = undefined
  }
  // outside a repository, or git missing: no line at all
  if (text === shown) return
  shown = text
  $.ui.status(text)
}

// "## main...origin/main [ahead 1, behind 2]" then one line per file ("?? " for a new one)
function describe(out: string) {
  const T = TEXT[locale]
  const lines = out.split(/\r?\n/).filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines[0].slice(3) : ''
  const files = lines.slice(head ? 1 : 0)
  const added = files.filter(l => l.startsWith('??')).length
  const changed = files.length - added

  let branch = head.split('...')[0]?.split(' ')[0] ?? ''
  if (branch === 'HEAD') branch = T.detached
  if (branch.startsWith('No')) branch = head.replace(/^No commits yet on /, '')
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  const hasUpstream = head.includes('...')

  const parts = [`⎇ ${branch}`]
  if (changed > 0) parts.push(T.changed(changed))
  if (added > 0) parts.push(T.added(added))
  if (changed === 0 && added === 0) parts.push(T.clean)
  if (!hasUpstream) parts.push(T.local)
  else if (ahead > 0 || behind > 0) parts.push([ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' '))
  return parts.join(' · ')
}
