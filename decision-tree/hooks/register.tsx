import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DecisionAsk,
  DecisionFork,
  DecisionImplication,
  DecisionOption,
  DecisionQuestion,
} from '../types'

const PANE = 'decision-tree'
const TITLE = 'Decisión'

const phase = atom({ plugin: 'decision-tree', key: 'phase' } as const, 'idle')
const ask = atom({ plugin: 'decision-tree', key: 'ask' } as const, null)
const focus = atom({ plugin: 'decision-tree', key: 'focus' } as const, 0)
const picks = atom({ plugin: 'decision-tree', key: 'picks' } as const, {})
const implications = atom({ plugin: 'decision-tree', key: 'implications' } as const, {})
const forks = atom({ plugin: 'decision-tree', key: 'forks' } as const, {})
// Every fork this plugin started, never reset nor capped, so the guard below
// keeps holding a fork that outlives the ask it was started for.
const forkIds = atom({ plugin: 'decision-tree', key: 'forkIds' } as const, [])

// The guard's own memory, for its .catch, which may not call $: the forks it
// knows, the agents listed as someone else's, and the spawns under way, whose
// forks can call tools before $.agent.spawn hands back their id.
const knownForks = new Set<string>()
const foreignAgents = new Set<string>()
let pendingSpawns = 0

// What the last drawing said about the layout; unknown until the pane draws.
let isFullscreen: boolean | undefined

// What a fork may call: reading the workspace, nothing that changes it.
// Bash is judged per command by isReadOnlyShell. No WebFetch or WebSearch: a
// fork may read secrets (.env), and a URL or a query would carry them out.
const FORK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'ToolSearch'])

// The shell guard reads a command the way the shell will, then judges each
// simple command against an allowlist of binaries and, per binary, of flags.
//
// Quoting: the command is split into words by a small shell-word lexer, so
// a quoted flag (`'-delete'`) is judged as the flag it becomes. Quotes are
// allowed because patterns need them (`jq '.x'`, `grep 'a|b'`). Inside single
// quotes every character is literal; inside double quotes `$`, backtick and
// backslash are refused, since the shell expands them there. Unquoted, only
// plain characters pass (letters, digits, `_ . / : = , @ % + ~ -`, and `!` as a
// word of its own): no expansion, substitution, redirection, globbing or
// brace expansion. A glob is refused because it can expand to a file named
// like a flag (`--pre=./x`); `ls src/*.ts` is therefore refused, and the Glob
// tool is the way to list by pattern. The one redirection read is stderr's:
// `2>&1`, `2>/dev/null`, `2> /dev/null`. This is held for bash and zsh alike.
//
// Flags: every flag must be one the binary's spec lists, deny by default.
// Short flags may be bundled (`-la`); a value letter takes the rest of the
// word (`-n5`) or the next word (`-n 5`). Long flags match exactly, never by
// prefix (GNU and git accept unique prefixes, `--out` for `--output`), and a
// long flag's value is read only from `--name=value`: the next word is always
// judged on its own. A letter is listed as taking a value only where it does
// on both GNU and BSD, so no word the tool reads as a flag escapes the check.

type ShellSpec = {
  /** Short letters that take no value; any order, bundled. */
  short?: string
  /** Short letters that take a value: the rest of the word, else the next word. */
  shortValue?: string
  /** Long flags given bare. */
  long?: readonly string[]
  /** Long flags given as `--name=value`. */
  longValue?: readonly string[]
  /** Whether `-N` (a count, as `head -50`) is a flag. */
  count?: boolean
  /** The most operands it takes; a bare `-` counts. Any when absent. */
  maxOperands?: number
  /** What every operand must be. */
  operand?: (word: string) => boolean
}

const LOG_LONG = [
  '--oneline', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--graph',
  '--decorate', '--no-decorate', '--all', '--branches', '--tags', '--remotes', '--patch', '--follow',
  '--reverse', '--no-merges', '--merges', '--abbrev-commit', '--no-abbrev-commit', '--first-parent',
  '--color', '--no-color', '--summary', '--raw', '--topo-order', '--date-order', '--relative-date',
  '--pretty', '--format', '--full-history', '--source', '--left-right',
]
const LOG_VALUE = [
  '--format', '--pretty', '--since', '--until', '--after', '--before', '--author', '--committer', '--grep',
  '--max-count', '--skip', '--date', '--decorate', '--color', '--abbrev', '--diff-filter', '--stat',
]
const DIFF_LONG = [
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--cached', '--staged', '--patch',
  '--word-diff', '--color', '--no-color', '--minimal', '--patience', '--histogram', '--ignore-all-space',
  '--ignore-space-change', '--check', '--summary', '--raw', '--relative', '--exit-code', '--quiet',
  '--no-ext-diff', '--no-textconv',
]
const DIFF_VALUE = ['--unified', '--diff-filter', '--stat', '--color', '--word-diff', '--relative']

const GIT_SPECS: Record<string, ShellSpec> = {
  status: {
    short: 'sbz',
    long: ['--short', '--branch', '--porcelain', '--long', '--ignored', '--untracked-files'],
    longValue: ['--porcelain', '--untracked-files', '--ignored'],
  },
  diff: { short: 'pRwbz', long: DIFF_LONG, longValue: DIFF_VALUE },
  log: { short: 'pz', shortValue: 'nSG', count: true, long: LOG_LONG, longValue: LOG_VALUE },
  show: {
    short: 'pwz',
    shortValue: 'n',
    count: true,
    long: [...LOG_LONG, ...DIFF_LONG],
    longValue: [...LOG_VALUE, ...DIFF_VALUE],
  },
  blame: { short: 'wslefnpct', shortValue: 'L', long: ['--porcelain', '--line-porcelain', '--show-email'] },
  'ls-files': {
    short: 'cdmoiksutvfz',
    long: ['--others', '--cached', '--modified', '--deleted', '--exclude-standard', '--error-unmatch', '--stage', '--full-name', '--directory'],
    longValue: ['--exclude'],
  },
  'rev-parse': {
    short: 'q',
    long: [
      '--show-toplevel', '--abbrev-ref', '--short', '--git-dir', '--git-common-dir', '--absolute-git-dir',
      '--is-inside-work-tree', '--is-bare-repository', '--verify', '--symbolic-full-name', '--show-prefix', '--show-cdup',
    ],
    longValue: ['--short'],
  },
  describe: {
    long: ['--tags', '--always', '--dirty', '--long', '--all', '--contains', '--exact-match'],
    longValue: ['--abbrev', '--match', '--exclude', '--dirty'],
  },
  branch: { short: 'arv', long: ['--all', '--remotes', '--list', '--show-current', '--verbose'], maxOperands: 0 },
  remote: { short: 'v', long: ['--verbose'], maxOperands: 0 },
}

const SHELL_SPECS: Record<string, ShellSpec | 'any'> = {
  echo: 'any',
  true: 'any',
  pwd: { short: 'LP', maxOperands: 0 },
  ls: {
    short: 'aAbBcCdfFgGhHiklLmnopqQrRsStTuUvwx1',
    long: ['--all', '--almost-all', '--human-readable', '--recursive', '--reverse', '--color', '--classify', '--directory'],
    longValue: ['--color', '--sort', '--time-style'],
  },
  cat: { short: 'AbeEnstTuv', long: ['--number', '--number-nonblank', '--show-all', '--squeeze-blank'] },
  head: { short: 'qv', shortValue: 'nc', count: true, long: ['--quiet', '--silent', '--verbose'], longValue: ['--lines', '--bytes'] },
  // No -f, -F, --follow or --retry: a fork that follows a file never ends.
  tail: { short: 'qrv', shortValue: 'nc', count: true, long: ['--quiet', '--silent', '--verbose'], longValue: ['--lines', '--bytes'] },
  grep: {
    short: 'rRnilLcvwxoqsHhEFGIPabU',
    shortValue: 'efmABCdD',
    count: true,
    long: [
      '--recursive', '--line-number', '--ignore-case', '--files-with-matches', '--files-without-match', '--count',
      '--word-regexp', '--line-regexp', '--fixed-strings', '--extended-regexp', '--perl-regexp', '--only-matching',
      '--no-filename', '--with-filename', '--invert-match', '--color', '--colour', '--quiet', '--no-messages',
    ],
    longValue: ['--include', '--exclude', '--exclude-dir', '--color', '--colour', '--max-count', '--context', '--binary-files'],
  },
  // No --pre, --pre-glob or --hostname-bin (each runs a program), nor -z
  // (runs decompressors).
  rg: {
    short: 'nNiIsSlcwxvFuoHLpq0.UPabh',
    shortValue: 'eftTgABCmMjErd',
    long: [
      '--files', '--hidden', '--no-ignore', '--no-ignore-vcs', '--no-heading', '--heading', '--count', '--json',
      '--vimgrep', '--line-number', '--no-line-number', '--ignore-case', '--smart-case', '--case-sensitive',
      '--fixed-strings', '--word-regexp', '--files-with-matches', '--files-without-match', '--follow', '--type-list',
      '--multiline', '--only-matching', '--invert-match', '--no-messages', '--count-matches', '--with-filename',
    ],
    longValue: [
      '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth', '--max-columns', '--color', '--sort',
      '--sortr', '--context', '--after-context', '--before-context', '--max-filesize',
    ],
  },
  wc: { short: 'lwcmL', long: ['--lines', '--words', '--bytes', '--chars', '--max-line-length'] },
  which: { short: 'as' },
  // No -C or -m (compile and choose magic files), nor -z (runs decompressors).
  file: { short: 'bhiLkN', long: ['--mime', '--mime-type', '--mime-encoding', '--brief', '--dereference', '--no-dereference'] },
  stat: { short: 'LflrsxFtq', shortValue: 'c', long: ['--dereference', '--terse'], longValue: ['--format', '--printf'] },
  // No -o (writes the listing), -H or -R (write HTML files).
  tree: {
    short: 'adfilspugDFCnNqvrtUxAShJX',
    shortValue: 'LIP',
    long: ['--dirsfirst', '--noreport', '--gitignore', '--prune'],
  },
  du: { short: 'ahcskmxLHP0', shortValue: 'd', long: ['--human-readable', '--summarize', '--apparent-size'], longValue: ['--max-depth'] },
  df: { short: 'hHkilTPa', long: ['--human-readable'] },
  // Only `+FORMAT` operands: on BSD a bare operand sets the clock; no -s,
  // --set or -d either.
  date: {
    short: 'uRjI',
    shortValue: 'rv',
    long: ['--utc', '--universal', '--iso-8601', '--rfc-email'],
    longValue: ['--iso-8601', '--rfc-3339', '--reference', '--date'],
    operand: word => word.startsWith('+'),
  },
  // No -o/--output, -T/--temporary-directory or --compress-program (runs a program).
  sort: {
    short: 'bdfgiMhnRrVuscCmz',
    shortValue: 'tkS',
    long: [
      '--reverse', '--unique', '--numeric-sort', '--human-numeric-sort', '--version-sort', '--ignore-case',
      '--general-numeric-sort', '--month-sort', '--stable', '--check', '--merge', '--zero-terminated',
      '--dictionary-order', '--ignore-leading-blanks', '--random-sort',
    ],
    longValue: ['--key', '--field-separator', '--buffer-size', '--sort'],
  },
  // A second operand is the file uniq writes to.
  uniq: {
    short: 'cdDuiz',
    shortValue: 'fsw',
    long: ['--count', '--repeated', '--unique', '--ignore-case'],
    longValue: ['--skip-fields', '--skip-chars', '--check-chars'],
    maxOperands: 1,
  },
  cut: {
    short: 'snw',
    shortValue: 'bcfd',
    long: ['--complement', '--only-delimited'],
    longValue: ['--delimiter', '--fields', '--characters', '--bytes'],
  },
  tr: { short: 'cCdsu', maxOperands: 2 },
  nl: { short: 'p', shortValue: 'bdfhilnsvw' },
  diff: {
    short: 'uaBbdEeiNnpqrsTtwy',
    shortValue: 'UCDILFSWxX',
    long: ['--unified', '--recursive', '--brief', '--side-by-side', '--ignore-all-space', '--ignore-space-change', '--new-file', '--text'],
    longValue: ['--unified', '--color', '--exclude', '--label'],
    maxOperands: 2,
  },
  jq: {
    short: 'rcensSjaCMRf',
    long: [
      '--raw-output', '--compact-output', '--slurp', '--null-input', '--sort-keys', '--join-output', '--exit-status',
      '--raw-input', '--ascii-output', '--tab', '--indent', '--arg', '--argjson', '--slurpfile', '--rawfile', '--args', '--jsonargs',
    ],
  },
  basename: { short: 'az', shortValue: 's', long: ['--multiple', '--zero'], longValue: ['--suffix'] },
  dirname: { short: 'z', long: ['--zero'] },
  realpath: { short: 'eEmLPqsz', longValue: ['--relative-to', '--relative-base'] },
}

// find's expression: tests and actions that only read and print.
const FIND_LEADING = new Set(['-H', '-L', '-P', '-E'])
const FIND_PLAIN = new Set([
  '-print', '-print0', '-prune', '-empty', '-depth', '-xdev', '-mount', '-follow', '-readable', '-executable',
  '-nouser', '-nogroup', '-true', '-false', '-not', '-a', '-o', '-and', '-or', '!', '(', ')', '-ls',
])
const FIND_VALUE = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype',
  '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-perm',
  '-user', '-group', '-uid', '-gid', '-links', '-inum', '-samefile', '-lname', '-ilname',
])

/** Whether find's words (after `find`) read and print only. */
function findReadsOnly(words: readonly string[]): boolean {
  let i = 0
  while (i < words.length && FIND_LEADING.has(words[i] ?? '')) i += 1
  // The starting points: words up to the first that opens the expression.
  while (i < words.length && !/^[-!()]/.test(words[i] ?? '')) i += 1
  while (i < words.length) {
    const word = words[i] ?? ''
    if (FIND_VALUE.has(word)) {
      if (i + 1 >= words.length) return false
      i += 2
    } else if (FIND_PLAIN.has(word)) {
      i += 1
    } else {
      return false
    }
  }
  return true
}

/** Whether the words after a binary (or a git subcommand) keep to its spec. */
function keepsToSpec(words: readonly string[], spec: ShellSpec): boolean {
  let operands = 0
  let isPastFlags = false
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (!isPastFlags && word === '--') {
      isPastFlags = true
      continue
    }
    if (isPastFlags || word === '-' || !word.startsWith('-')) {
      operands += 1
      if (spec.operand !== undefined && !spec.operand(word)) return false
      continue
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq === -1 ? word : word.slice(0, eq)
      const isListed = eq === -1 ? (spec.long ?? []).includes(name) : (spec.longValue ?? []).includes(name)
      if (!isListed) return false
      continue
    }
    if (spec.count === true && /^-\d+$/.test(word)) continue

    const letters = word.slice(1)
    for (let j = 0; j < letters.length; j += 1) {
      const letter = letters[j] ?? ''
      if ((spec.short ?? '').includes(letter)) continue
      if (!(spec.shortValue ?? '').includes(letter)) return false
      // A value letter takes the rest of the word, or else the next word.
      if (j === letters.length - 1) {
        if (i + 1 >= words.length) return false
        i += 1
      }
      break
    }
  }
  return spec.maxOperands === undefined || operands <= spec.maxOperands
}

// A spec of the table's own, never one inherited (`toString`, `constructor`).
function specOf<T>(table: Record<string, T>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined
}

function isReadOnlyStep(words: readonly string[]): boolean {
  const [bin = '', ...rest] = words
  if (bin === 'find') return findReadsOnly(rest)
  if (bin === 'git') {
    // Nothing between git and its subcommand: -c and -C change what runs.
    const [sub = '', ...args] = rest
    const spec = specOf(GIT_SPECS, sub)
    return spec !== undefined && keepsToSpec(args, spec)
  }
  const spec = specOf(SHELL_SPECS, bin)
  if (spec === undefined) return false
  return spec === 'any' || keepsToSpec(rest, spec)
}

const PLAIN_CHAR = /[A-Za-z0-9_./:=,@%+~-]/
const STDERR_REDIRECTS = ['2>&1', '2>/dev/null', '2> /dev/null']

/**
 * The simple commands of a command line, each as the words the shell would
 * pass, quotes removed; null when the line holds anything the lexer does not
 * read as plain (see the comment above ShellSpec).
 */
export function shellSteps(command: string): string[][] | null {
  const steps: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endStep = () => {
    endWord()
    if (words.length > 0) steps.push(words)
    words = []
  }
  const isBoundary = (at: number) => at >= command.length || /[\s;&|]/.test(command[at] ?? '')

  let i = 0
  while (i < command.length) {
    const c = command[i] ?? ''
    if (word === null) {
      const redirect = STDERR_REDIRECTS.find(r => command.startsWith(r, i) && isBoundary(i + r.length))
      if (redirect !== undefined) {
        i += redirect.length
        continue
      }
      if (c === '!' && isBoundary(i + 1)) {
        words.push('!')
        i += 1
        continue
      }
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return null
      word = (word ?? '') + command.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      const close = command.indexOf('"', i + 1)
      if (close === -1) return null
      const inner = command.slice(i + 1, close)
      if (/[$`\\]/.test(inner)) return null
      word = (word ?? '') + inner
      i = close + 1
    } else if (c === ' ' || c === '\t') {
      endWord()
      i += 1
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      // `|`, `||`, `&&`, `&`, `;` and a newline all end a simple command.
      endStep()
      i += 1
    } else if (PLAIN_CHAR.test(c)) {
      word = (word ?? '') + c
      i += 1
    } else {
      return null
    }
  }
  endStep()
  return steps
}

export function isReadOnlyShell(command: string): boolean {
  const steps = shellSteps(command)
  return steps !== null && steps.length > 0 && steps.every(isReadOnlyStep)
}

/** Whether a fork this plugin started may make this call: read and look up, never change. */
export function forkMayCall(tool: string, input: { command?: unknown }): boolean {
  if (FORK_TOOLS.has(tool)) return true

  return tool === 'Bash' && typeof input.command === 'string' && isReadOnlyShell(input.command)
}

type AskedQuestion = {
  question: string
  header?: string
  options?: readonly { label: string; description?: string }[]
}

/** An AskUserQuestion call's questions as the panel holds them; null when none has options. */
export function fromToolQuestions(questions: readonly AskedQuestion[]): DecisionQuestion[] | null {
  const held = questions
    .filter(q => (q.options ?? []).length > 0)
    .map(q => ({
      text: q.question,
      header: q.header,
      options: (q.options ?? []).map(o => ({ label: o.label, reply: o.label, detail: o.description })),
    }))
  return held.length > 0 ? held : null
}

/** What is sent when the person confirms: the reply alone for one question, a list for several. */
export function composeAnswer(a: DecisionAsk, chosen: Record<string, number>): string {
  const replies = a.questions.map((q, i) => ({ q, option: q.options[chosen[i] ?? 0] }))
  if (replies.length === 1 && a.source === 'text') return replies[0]?.option?.reply ?? ''

  const lines = replies.map(({ q, option }) => `- ${q.text} → ${option?.reply ?? '(sin respuesta)'}`)
  return `Mis respuestas:\n${lines.join('\n')}`
}

const ASK_PROMPT = (answer: string) => `You read the end of an assistant reply and decide whether it ends by asking the user a question they are expected to answer.

Reply with JSON only, no prose, no code fence:
- no question: {"question": null}
- a question: {"question": "<the question, as asked, in its own language>", "options": [{"label": "<2-6 words>", "reply": "<what the user would type to give this answer, first person, in the question's language>"}]}

Give 2 to 4 options: the ones the reply offered, else the natural answers (yes/no plus a meaningful alternative). Do not invent options unrelated to the reply.

The end of the reply:
<<<
${answer.slice(-2500)}
>>>`

const IMPLY_PROMPT = (a: DecisionAsk, q: DecisionQuestion, reply: string) => `[decision-tree: análisis, no es mi respuesta]
Tu última respuesta terminó así:
<<<
${a.context}
>>>
Y me preguntabas: «${q.text}»
Si te respondiera: «${reply}»

¿Qué conlleva esa respuesta? No hagas nada todavía, sólo analiza. Responde en markdown, máximo 10 líneas, en el idioma de la pregunta, con estas partes en negrita: **Qué harías después**, **A favor**, **En contra / riesgos**, **Reversible**.`

const FORK_PROMPT = (a: DecisionAsk, q: DecisionQuestion, reply: string) => `[Rama de prueba de decision-tree: esta NO es mi respuesta definitiva]
Tu última respuesta terminó así:
<<<
${a.context}
>>>
A tu pregunta «${q.text}» respondo: «${reply}»

Sigue como si esta fuera mi respuesta real, pero como ensayo: investiga y lee lo que necesites; no modifiques archivos ni ejecutes nada que cambie estado (en esta rama esas herramientas están bloqueadas, así que no lo intentes en bucle). Cuando tengas suficiente, termina con un informe en markdown:
**Qué haría**: los pasos concretos.
**Cambios**: archivos y cambios propuestos (diffs cortos si ayudan).
**Riesgos** y **Lo que aún no sé**.`

// Marks the refusal as this plugin's handoff, for the transcript row that draws it.
const HANDOFF_MARK = '[decision-tree]'
const HANDOFF = `${HANDOFF_MARK} La persona va a decidir en el panel lateral de decision-tree, donde ve estas mismas opciones, lo que conlleva cada una y puede probarlas en ramas. Su respuesta llegará como su próximo mensaje. Termina tu turno ahora con una frase breve, sin repetir la pregunta ni las opciones.`

function parseQuestion(text: string): DecisionQuestion | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return null
  try {
    const value = JSON.parse(json) as { question?: unknown; options?: unknown }
    if (typeof value.question !== 'string' || !Array.isArray(value.options)) return null
    const options = value.options
      .filter((o): o is DecisionOption => typeof o?.label === 'string' && typeof o?.reply === 'string')
      .slice(0, 6)
    return options.length > 0 ? { text: value.question, options } : null
  } catch {
    return null
  }
}

function endsWithQuestion(answer: string): boolean {
  return /\?/.test(answer.trim().slice(-600))
}

const slotOf = (id: string, qi: number, oi: number) => `${id}:${qi}:${oi}`

async function settle($: EngineInterface) {
  await update($, ask, () => null)
  await update($, phase, () => 'idle')
  $.ui.status(undefined)
}

// How many finished forks of earlier asks stay readable in the panel.
const KEPT_REPORTS = 10
const STOPPED = 'Rama detenida: la pregunta cambió antes de que terminara.'

/** Stops a fork whose question is gone, best effort: TaskStop takes a background agent by its id. */
function stopFork($: EngineInterface, agentId: string) {
  void $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

const isFinished = (fork: DecisionFork) => fork.status === 'done' || fork.status === 'error'

/**
 * Hands the forks of earlier asks over to a new one: a running fork is
 * stopped, a finished one stays readable (the latest KEPT_REPORTS of them).
 */
async function retireForks($: EngineInterface, askId: string) {
  const isEarlier = (slot: string) => !slot.startsWith(`${askId}:`)
  const running = Object.entries(await read($, forks)).filter(([slot, fork]) => isEarlier(slot) && fork.status === 'running')
  for (const [, fork] of running) if (fork.agentId !== undefined) stopFork($, fork.agentId)

  await update($, forks, all => {
    const entries = Object.entries(all).map(([slot, fork]): [string, DecisionFork] =>
      isEarlier(slot) && fork.status === 'running' ? [slot, { ...fork, status: 'error', text: STOPPED }] : [slot, fork],
    )
    const finished = entries.filter(([slot, fork]) => isEarlier(slot) && isFinished(fork))
    const dropped = new Set(finished.slice(0, Math.max(0, finished.length - KEPT_REPORTS)).map(([slot]) => slot))
    return Object.fromEntries(entries.filter(([slot]) => !dropped.has(slot)))
  })
}

/** Seats a new ask, clearing the last one's analysis and retiring its forks; resolves whether the pane is drawn. */
async function present($: EngineInterface, next: DecisionAsk, isAsked: boolean) {
  await update($, ask, () => next)
  await update($, focus, () => 0)
  await update($, picks, () => ({}))
  await update($, implications, () => ({}))
  await retireForks($, next.id)
  await update($, phase, () => 'ready')
  const count = next.questions.length > 1 ? `${next.questions.length} preguntas` : 'una pregunta'
  $.ui.status(`decision-tree: ${count} para explorar · /decision-tree`)

  // Unasked, open only where the pane docks beside the transcript; on the
  // main screen it would open inline, so the status line points to it instead.
  const shouldOpen = isAsked || isFullscreen !== false
  const isPlaced = shouldOpen ? (await $.ui.open({ id: PANE, title: TITLE })).isPlaced : false
  // A dialog the pane could not take goes back to the native one: nothing to analyse.
  if (!isAsked || isPlaced) void imply($, next.id, 0, 0)
  return isPlaced
}

// The main turn that ended last; undefined once the person spoke after it. A
// question read for any other turn is stale and dropped.
let latestTurn: string | undefined

async function readQuestion($: EngineInterface, answer: string, turnId: string) {
  await update($, phase, () => 'reading')
  const reply = await $.model.complete({ model: 'haiku', prompt: ASK_PROMPT(answer), maxTokens: 800 })
  if (latestTurn !== turnId) return
  const found = reply.isAnswered ? parseQuestion(reply.text) : null

  if (found === null) {
    await settle($)
    await update($, phase, () => 'none')
    return
  }
  const context = answer.trim().slice(-2000)
  await present($, { id: turnId, source: 'text', context, questions: [found] }, false)
}

async function current($: EngineInterface, id: string) {
  const a = await read($, ask)
  return a !== null && a.id === id ? a : null
}

// Slots whose analysis or fork is being started: a second press of the same
// option waits for nothing and starts nothing.
const implying = new Set<string>()
const branching = new Set<string>()

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Analyses an option once; a failure is shown as such, never left loading. */
async function imply($: EngineInterface, id: string, qi: number, oi: number) {
  const slot = slotOf(id, qi, oi)
  if (implying.has(slot)) return
  implying.add(slot)
  try {
    await analyse($, id, qi, oi, slot)
  } catch (error) {
    const failed: DecisionImplication = { status: 'error', text: `No se pudo analizar (${reasonOf(error)}).` }
    await update($, implications, all => ({ ...all, [slot]: failed })).catch(() => undefined)
  } finally {
    implying.delete(slot)
  }
}

async function analyse($: EngineInterface, id: string, qi: number, oi: number, slot: string) {
  const a = await current($, id)
  const q = a?.questions[qi]
  const option = q?.options[oi]
  if (a === null || q === undefined || option === undefined) return
  if ((await read($, implications))[slot] !== undefined) return

  const loading: DecisionImplication = { status: 'loading', text: '' }
  await update($, implications, all => ({ ...all, [slot]: loading }))
  const r = await $.model.fork({ prompt: IMPLY_PROMPT(a, q, option.reply) })
  if ((await current($, id)) === null) return

  const result: DecisionImplication = r.isAnswered
    ? { status: 'ready', text: r.text }
    : { status: 'error', text: `No se pudo analizar (${r.reason}).` }
  await update($, implications, all => ({ ...all, [slot]: result }))
}

async function rememberFork($: EngineInterface, agentId: string) {
  knownForks.add(agentId)
  await update($, forkIds, ids => (ids.includes(agentId) ? ids : [...ids, agentId]))
}

/** Whether the agent is a fork this plugin started, its id handed back yet or not. */
async function isOwnFork($: EngineInterface, agentId: string): Promise<boolean> {
  if (knownForks.has(agentId)) return true
  if (foreignAgents.has(agentId)) return false
  if ((await read($, forkIds)).includes(agentId)) {
    knownForks.add(agentId)
    return true
  }
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed?.spawnedBy === 'decision-tree') {
    await rememberFork($, agentId)
    return true
  }
  if (listed !== undefined) {
    foreignAgents.add(agentId)
    return false
  }
  // Listed by nobody yet: while a spawn of this plugin is under way, it may
  // be that fork. Not remembered either way; the next call asks again.
  return pendingSpawns > 0
}

/** Starts one fork for an option; a second press while it starts does nothing. */
async function branch($: EngineInterface, id: string, qi: number, oi: number) {
  const slot = slotOf(id, qi, oi)
  if (branching.has(slot)) return
  branching.add(slot)
  try {
    await startFork($, id, qi, oi, slot)
  } finally {
    branching.delete(slot)
  }
}

async function startFork($: EngineInterface, id: string, qi: number, oi: number, slot: string) {
  const a = await current($, id)
  const q = a?.questions[qi]
  const option = q?.options[oi]
  if (a === null || q === undefined || option === undefined) return
  const existing = (await read($, forks))[slot]
  if (existing !== undefined && existing.status !== 'error') return

  const about = { label: option.label, question: q.text }
  const setFork = (fork: DecisionFork) => update($, forks, all => ({ ...all, [slot]: { ...about, ...fork } }))
  await setFork({ status: 'starting', text: '' })
  // Held until the id is remembered: the fork may call tools before then.
  pendingSpawns += 1
  try {
    const spawned = await $.agent.spawn({
      subagentType: 'fork',
      description: `Rama: ${option.label}`.slice(0, 60),
      prompt: FORK_PROMPT(a, q, option.reply),
    })
    if (spawned.deny !== undefined || spawned.agentId === undefined) {
      await setFork({ status: 'error', text: `La rama no arrancó: ${spawned.deny ?? 'sin id de agente'}` })
      return
    }
    const agentId = spawned.agentId
    await rememberFork($, agentId)
    // Its question was replaced while it started: nobody waits for it now.
    if ((await current($, id)) === null) {
      stopFork($, agentId)
      await setFork({ status: 'error', agentId, text: STOPPED })
      return
    }
    await setFork({ status: 'running', agentId, text: '' })
  } catch (error) {
    await setFork({ status: 'error', text: `La rama no arrancó: ${String(error)}` })
  } finally {
    pendingSpawns -= 1
  }
}

async function confirm($: EngineInterface, id: string, mode: 'send' | 'edit') {
  const a = await current($, id)
  if (a === null) return
  const text = composeAnswer(a, await read($, picks))
  if (mode === 'edit') {
    await $.prompt.fill({ text })
    return
  }
  await settle($)
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'decision-tree',
      description: 'Abre el panel de la última pregunta: opciones, lo que conllevan y ramas de prueba',
    })
    return next(e)
  })

  on('command.run', { command: 'decision-tree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Panel de decision-tree abierto.' }
  })

  // The model's own question dialog: where the panel can be drawn, the panel
  // takes the questions and the answer comes back as the person's next message.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined || e.tool !== 'AskUserQuestion') return next(e)
    const questions = fromToolQuestions(e.questions)
    if (questions === null) return next(e)

    const context = questions
      .map(q => `${q.text}\n${q.options.map(o => `- ${o.label}${o.detail ? `: ${o.detail}` : ''}`).join('\n')}`)
      .join('\n\n')
    const isPlaced = await present($, { id: e.tool_use_id, source: 'tool', context, questions }, true)
    if (!isPlaced) {
      await settle($)
      return next(e)
    }
    return { deny: HANDOFF }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A fork's answer is its report, kept with the fork even when its ask is gone.
      const agentId = e.agentId
      const all = await read($, forks)
      const slot = Object.keys(all).find(key => all[key]?.agentId === agentId)
      const was = slot === undefined ? undefined : all[slot]
      if (slot !== undefined && was !== undefined) {
        if (e.reason === 'answer') {
          const done: DecisionFork = { ...was, status: 'done', agentId, text: e.answer }
          await update($, forks, now => ({ ...now, [slot]: done }))
          $.ui.toast('decision-tree: rama lista, mírala en el panel')
        } else if (was.status !== 'error') {
          // One already marked (stopped when its question changed) keeps its line.
          const failed: DecisionFork = { ...was, status: 'error', agentId, text: `La rama terminó sin respuesta (${e.reason}).` }
          await update($, forks, now => ({ ...now, [slot]: failed }))
        }
      }
      return next(e)
    }

    // Any reading still under way is for an older turn now.
    latestTurn = e.turnId

    // An AskUserQuestion handed to the panel stays until it is answered.
    const pending = await read($, ask)
    if (pending?.source === 'tool') return next(e)

    if (e.reason === 'answer' && endsWithQuestion(e.answer)) {
      const turnId = e.turnId
      void readQuestion($, e.answer, turnId).catch(() =>
        latestTurn === turnId ? update($, phase, () => 'none') : undefined,
      )
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A fork's completion would otherwise wake the main conversation with its
    // report before the person chose anything; the panel shows it instead.
    // Dropped only for a fork the panel holds: any other reaches the conversation.
    if (e.origin?.kind === 'task-notification') {
      const held = Object.values(await read($, forks)).some(
        fork => fork.agentId !== undefined && e.text.includes(fork.agentId),
      )
      if (held) return { drop: 'decision-tree: la rama terminó; su informe está en el panel (/decision-tree).' }
      return next(e)
    }
    // The person answered on their own (at the prompt, from the phone or as
    // the SDK host): whatever question the panel holds is settled, and one
    // still being read is dropped.
    const kind = e.origin?.kind
    if (kind === undefined || kind === 'composer' || kind === 'bridge' || kind === 'sdk') {
      latestTurn = undefined
      if ((await read($, ask)) !== null || (await read($, phase)) === 'reading') await settle($)
    }
    return next(e)
  })

  const forkDeny = (tool: string) => ({
    deny: `decision-tree: esta es una rama de prueba; ${tool} no está permitido aquí. Describe el cambio en tu informe en lugar de aplicarlo.`,
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    if (!(await isOwnFork($, e.agentId))) return next(e)

    const tool = String(e.tool)
    if (forkMayCall(tool, { command: 'command' in e ? e.command : undefined })) return next(e)
    return forkDeny(tool)
  }).catch(($, e, next) => {
    // Judged from what this module holds: $ may not answer here.
    if (next.called || e.agentId === undefined || foreignAgents.has(e.agentId)) return next(e)
    const tool = String(e.tool)
    if (knownForks.has(e.agentId)) {
      return forkMayCall(tool, { command: 'command' in e ? e.command : undefined }) ? next(e) : forkDeny(tool)
    }
    if (pendingSpawns > 0) {
      return { deny: 'decision-tree: no se pudo comprobar si esta llamada viene de una rama de prueba.' }
    }
    return next(e)
  })

  // The handed-off dialog's transcript row: a card pointing to the panel in
  // place of the refusal text the model reads.
  const isHandoff = (output: unknown) => typeof output === 'string' && (output.includes(HANDOFF_MARK) || output.includes('panel lateral de decision-tree'))

  on('ui.render', { component: 'ToolUse', props: { tool: 'AskUserQuestion' } }, async ($, e, next) => {
    if (!e.props.isErrored || !isHandoff(e.props.output)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const input = e.props.input as { questions?: readonly AskedQuestion[] } | undefined
    const headers = (input?.questions ?? []).map((q, i) => q.header ?? `Pregunta ${i + 1}`)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Text>
          <Text color="claude" bold>◆ decision-tree</Text>
          <Text dimColor>  {headers.length === 1 ? '1 pregunta' : `${headers.length} preguntas`} en el panel lateral</Text>
        </Text>
        <Text wrap="wrap">
          {headers.map((header, i) => (
            <Text key={`h-${i}`}>
              <Text color="suggestion">{header}</Text>
              {i < headers.length - 1 ? <Text dimColor> · </Text> : ''}
            </Text>
          ))}
        </Text>
        <Text dimColor>Explora, prueba en rama y confirma desde el panel →</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'AskUserQuestion' } }, async ($, e, next) => {
    if (!e.props.isErrored || !isHandoff(e.props.output)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isFullscreen = e.viewport?.isFullscreen ?? isFullscreen
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const a = await read($, ask)
    const state = await read($, phase)
    const allForks = await read($, forks)
    const width = e.props.bodyColumns

    // The finished forks of earlier asks, newest first: their reports stay readable.
    const earlier = Object.entries(allForks)
      .filter(([slot, f]) => (a === null || !slot.startsWith(`${a.id}:`)) && isFinished(f))
      .slice(-3)
      .reverse()
    const earlierBox =
      earlier.length === 0 ? null : (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
          <Text dimColor bold>⑂ Ramas anteriores</Text>
          {earlier.map(([, f], i) => (
            <Box key={`prev-${i}`} flexDirection="column" marginTop={1}>
              <Text wrap="wrap">
                <Text bold>{f.label ?? 'Rama'}</Text>
                {f.question !== undefined ? <Text dimColor> · {f.question}</Text> : ''}
              </Text>
              <Markdown key={`prev-report-${i}`} text={f.text} dimColor={f.status === 'error'} />
            </Box>
          ))}
        </Box>
      )

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color="claude" bold>◆ decision-tree</Text>
        </Text>
        {a !== null && (
          <Text dimColor>{a.source === 'tool' ? 'pregunta de Claude' : 'pregunta final'}</Text>
        )}
      </Box>
    )

    if (a === null) {
      const message =
        state === 'reading' ? '◐ Leyendo la pregunta…' : 'Sin pregunta pendiente. Cuando Claude te pregunte algo, aparecerá aquí.'
      return (
        <Box flexDirection="column" gap={1} width={width}>
          {header}
          <Box borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text dimColor wrap="wrap">{message}</Text>
          </Box>
          {earlierBox}
        </Box>
      )
    }

    const qi = Math.min(await read($, focus), a.questions.length - 1)
    const q = a.questions[qi]
    if (q === undefined) return header
    const chosen = await read($, picks)
    const oi = Math.min(chosen[qi] ?? 0, q.options.length - 1)
    const option = q.options[oi]
    const slot = slotOf(a.id, qi, oi)
    const implication = (await read($, implications))[slot]
    const fork = allForks[slot]

    const showQuestion = (i: number) => {
      void update($, focus, () => i)
      void read($, picks).then(now => imply($, a.id, i, now[i] ?? 0))
    }
    const choose = (i: number) => {
      void update($, picks, now => ({ ...now, [qi]: i }))
      void imply($, a.id, qi, i)
    }
    const addCustom = (text: string) => {
      const reply = text.trim()
      if (reply.length === 0) return
      const added = { label: reply.length > 40 ? `${reply.slice(0, 39)}…` : reply, reply }
      void update($, ask, now => {
        if (now === null || now.id !== a.id) return now
        const questions = now.questions.map((one, i) => (i === qi ? { ...one, options: [...one.options, added] } : one))
        return { ...now, questions }
      }).then(() => choose(q.options.length))
    }

    const chip = (f: DecisionFork | undefined) => {
      if (f === undefined) return null
      if (f.status === 'done') return <Text color="success"> ✓ rama lista</Text>
      if (f.status === 'error') return <Text color="error"> ✗ rama falló</Text>
      return <Text color="warning"> ◐ rama en curso</Text>
    }

    // Mobile draws no Input: there the options offered are the choice.
    let custom = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      custom = (
        <Box borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
          <Input
            key="custom"
            label="✎ Otra respuesta"
            placeholder="Escribe la tuya y pulsa Enter"
            submitLabel="Añadir"
            onSubmit={addCustom}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} width={width}>
        {header}

        {a.questions.length > 1 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {a.questions.map((one, i) => {
              const isDone = chosen[i] !== undefined
              return (
                <Button key={`q-${i}`} variant={i === qi ? 'primary' : 'secondary'} onPress={() => showQuestion(i)}>
                  {isDone ? '✓ ' : ''}
                  {one.header ?? `Pregunta ${i + 1}`}
                </Button>
              )
            })}
          </Box>
        )}

        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold wrap="wrap">{q.text}</Text>
          <Box flexDirection="column" marginTop={1}>
            {q.options.map((o, i) => {
              const isPicked = i === oi
              return (
                <Box
                  key={`row-${i}`}
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={isPicked ? 'suggestion' : 'subtle'}
                  borderDimColor={!isPicked}
                  paddingX={1}
                  hover={{ borderColor: 'suggestion' }}
                >
                  <Button key={`opt-${i}`} plain onPress={() => choose(i)}>
                    <Text color={isPicked ? 'suggestion' : 'inactive'}>{isPicked ? '● ' : '○ '}</Text>
                    <Text bold={isPicked}>{o.label}</Text>
                    {chip(allForks[slotOf(a.id, qi, i)])}
                  </Button>
                  {o.detail !== undefined && o.detail.length > 0 && (
                    <Text dimColor wrap="wrap">  {o.detail}</Text>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>

        {option !== undefined && (
          <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
            <Text color="permission" bold>⌥ Lo que conlleva · {option.label}</Text>
            {option.reply !== option.label && <Text dimColor wrap="wrap">Respuesta: «{option.reply}»</Text>}
            {implication === undefined || implication.status === 'loading' ? (
              <Text color="warning">◐ Analizando…</Text>
            ) : (
              <Markdown key="implication" text={implication.text} dimColor={implication.status === 'error'} />
            )}
          </Box>
        )}

        {option !== undefined && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="try" onPress={() => void branch($, a.id, qi, oi)}>
              ⑂ Probar en rama
            </Button>
            <Button key="send" variant="primary" onPress={() => void confirm($, a.id, 'send')}>
              {a.questions.length > 1 ? '✓ Confirmar todas' : '✓ Confirmar'}
            </Button>
            <Button key="edit" onPress={() => void confirm($, a.id, 'edit')}>
              ✎ Editar
            </Button>
          </Box>
        )}

        {fork !== undefined && (
          <Box
            flexDirection="column"
            borderStyle={fork.status === 'done' ? 'round' : 'dashed'}
            borderColor={fork.status === 'done' ? 'success' : fork.status === 'error' ? 'error' : 'warning'}
            paddingX={1}
          >
            <Text bold color={fork.status === 'done' ? 'success' : fork.status === 'error' ? 'error' : 'warning'}>
              ⑂ Rama de prueba · {option?.label}
            </Text>
            {fork.status === 'starting' && <Text dimColor>◐ Arrancando la rama…</Text>}
            {fork.status === 'running' && <Text dimColor>◐ Trabajando en sólo lectura. Te aviso al terminar.</Text>}
            {(fork.status === 'done' || fork.status === 'error') && (
              <Markdown key="fork" text={fork.text} dimColor={fork.status === 'error'} />
            )}
          </Box>
        )}

        {custom}

        {earlierBox}
      </Box>
    )
  })
}
