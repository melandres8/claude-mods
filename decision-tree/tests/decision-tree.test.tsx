import { expect, test } from 'claude-code/testing'
import type { AgentInfo, EngineInterface, On } from 'claude-code'

import { composeAnswer, forkMayCall, fromToolQuestions, isReadOnlyShell } from '../hooks/register'

const QUESTION = {
  question: '¿Lo hago con Postgres o con SQLite?',
  options: [
    { label: 'Postgres', reply: 'Usa Postgres.' },
    { label: 'SQLite', reply: 'Usa SQLite.' },
  ],
}

const PANE = { component: 'Pane', props: { title: 'Decisión' }, requestId: 'decision-tree' } as const

function world(on: On) {
  const seen = {
    spawns: [] as string[],
    submits: [] as string[],
    completes: 0,
    opened: 0,
    /** What `$.agent.list()` answers. */
    agents: [] as AgentInfo[],
    isListFailing: false,
    /** Holds a spawn until it resolves, as a slow start does. */
    spawnGate: Promise.resolve(),
    /** `$.model.fork` calls, the analysis of an option. */
    forkCalls: 0,
    forkGate: Promise.resolve(),
    isForkFailing: false,
    /** Whether `$.ui.open` places the pane. */
    isPlaced: true,
  }
  on('agent.list', () => {
    if (seen.isListFailing) throw new Error('agent.list failed')
    return { value: seen.agents } as never
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('model.complete', () => {
    seen.completes += 1
    return { value: { isAnswered: true, text: JSON.stringify(QUESTION), usage: usage() } } as never
  })
  on('model.fork', async () => {
    seen.forkCalls += 1
    await seen.forkGate
    if (seen.isForkFailing) throw new Error('model.fork failed')
    return { value: { isAnswered: true, text: '**Qué harías después**: migrar.', usage: usage() } } as never
  })
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: seen.isPlaced } } as never
  })
  on('agent.spawn', async (_$, e) => {
    seen.spawns.push(e.prompt)
    await seen.spawnGate
    return { model: 'test', agentId: 'fork-1' }
  })
  on('prompt.submit', (_$, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', (_$, e) => ({ ref: e.tool_use_id, result: 'ok', text: 'ok', isError: false }) as never)
  return seen
}

function usage() {
  return { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

function complete($: EngineInterface, answer: string, agentId?: string) {
  return $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: false,
    turnId: `turn-${Math.random()}`,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  } as never)
}

// The question is read after turn.complete returns; wait for the pane to open.
async function settle($: EngineInterface, ready: () => boolean) {
  for (let i = 0; i < 500; i += 1) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('never settled')
}

test('a reply that ends in a question fills the panel; a subagent reply does not', async ($, on) => {
  const seen = world(on)

  await complete($, 'Listo el análisis. ¿Lo hago con Postgres o con SQLite?', 'some-subagent')
  expect(seen.completes).toBe(0)

  await complete($, 'He terminado los cambios.')
  expect(seen.completes).toBe(0)

  await complete($, 'Listo el análisis. ¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.opened > 0)
  expect(seen.completes).toBe(1)

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Postgres o con SQLite/ })).toBeDefined()
  await ui.unmount()
})

test('trying an option spawns a fork with its reply; confirming sends it', async ($, on) => {
  const seen = world(on)
  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.opened > 0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'decision-tree', surface, ...PANE })
    expect(await ui.find({ key: 'try' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  await ui.press({ key: 'opt-1' })
  await ui.press({ key: 'try' })
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0]).toContain('Usa SQLite.')
  // The kit drops an agentId a test hook makes up (core sets it), so the
  // spawn lands on the panel's no-id path; the prompt it sent is checked above.
  expect(await ui.find({ type: 'Markdown', text: /La rama no arrancó/ })).toBeDefined()

  // Outside a fork this plugin started, the guard lets every call through.
  expect(await call($, { tool: 'Write', file_path: '/x', content: 'y' })).toBe(null)
  expect(await call($, { tool: 'Write', agentId: 'other', file_path: '/x', content: 'y' })).toBe(null)

  await ui.press({ key: 'send' })
  expect(seen.submits).toContain('Usa SQLite.')
  await ui.unmount()
})

test('read-only shell check', () => {
  expect(isReadOnlyShell('git diff HEAD~1 | head -50')).toBe(true)
  expect(isReadOnlyShell('grep -rn foo src 2>/dev/null')).toBe(true)
  expect(isReadOnlyShell('echo hi > file')).toBe(false)
  expect(isReadOnlyShell('sed -i s/a/b/ f')).toBe(false)
  expect(isReadOnlyShell('find . -name x -delete')).toBe(false)
  expect(isReadOnlyShell('git branch -D main')).toBe(false)
  expect(isReadOnlyShell('npm install')).toBe(false)
  expect(isReadOnlyShell('ls & rm -rf build')).toBe(false)
  expect(isReadOnlyShell('env rm -rf x')).toBe(false)
  expect(isReadOnlyShell('sort -o out in')).toBe(false)
  expect(isReadOnlyShell('uniq in out')).toBe(false)
  expect(isReadOnlyShell('tree -o f')).toBe(false)
  expect(isReadOnlyShell('git diff --output=f')).toBe(false)
  expect(isReadOnlyShell('git branch newname')).toBe(false)
  expect(isReadOnlyShell('sed --in-place s/a/b/ f')).toBe(false)
  expect(isReadOnlyShell("sed -n 's/a/b/w out' f")).toBe(false)
  expect(isReadOnlyShell('git branch -a')).toBe(true)
  expect(isReadOnlyShell('sort f | uniq -c')).toBe(true)
})

// Each input below got past the guard once; none may again.
const SHELL_BYPASSES = [
  // rg runs a preprocessor or a hostname program of the caller's choosing.
  'rg --pre rm x .',
  'rg --pre=rm x .',
  'rg --pre-glob "*" --pre rm x .',
  'rg --hostname-bin=sh x .',
  'rg --pr rm x .',
  // A quote does not hide a flag.
  'find . "-delete"',
  "find . '-exec' rm {} +",
  "find . '-exec' rm '{}' '+'",
  "sort '-o' f in",
  // Attached, bundled and abbreviated output flags.
  'sort -uo src/index.ts /dev/null',
  'sort -osrc/x in',
  'sort --out=f in',
  'sort --output=f in',
  'git log --outp=f',
  'git log --output=f',
  'tree -ofile',
  'tree -R -H .',
  // A bare - is an operand: here it makes path/file the output.
  'uniq - path/file',
  'sort --compress-program=sh in',
  'sort --compress-program sh in',
  'file -C -m x',
  'tail -f log',
  'tail -F log',
  'tail --follow log',
  'tail -n5 -f log',
  'date -s 12:00',
  'date --set=12:00',
  'date 202610121200',
  // Expansion, substitution and redirection in any spelling.
  'echo $HOME',
  'echo "$(rm -rf x)"',
  'echo "`rm -rf x`"',
  "echo 'a' > f",
  'cat f >> g',
  'cat < f',
  'echo hi >| f',
  'ls \\\n-la',
  'grep foo f\\;rm x',
  // A glob can expand to a file named like a flag.
  'rg foo *',
  'ls src/*.ts',
  'find . {-delete,}',
  'ls [a]',
  // Separators inside and outside quotes.
  "grep 'a|b' f; rm x",
  'ls && rm x',
  'ls || rm x',
  'ls\nrm x',
  'ls & rm x',
  // Unterminated quotes, prefixes, and unknown binaries.
  "grep 'foo f",
  'FOO=1 ls',
  '/bin/rm x',
  'command rm x',
  'xargs rm',
  'toString',
  'git constructor',
  'git -c core.pager=sh log',
  'git -C .. log',
  'git log --ext-diff -p',
  'git diff --output=x',
  'git branch newname',
  'git stash',
  'git checkout .',
]

test('read-only shell check refuses every known bypass', () => {
  expect(SHELL_BYPASSES.filter(command => isReadOnlyShell(command))).toEqual([])
})

// What a fork uses every day must keep working.
const SHELL_READS = [
  'ls',
  'ls -la',
  'ls -la src',
  'grep -rn foo src',
  'grep -rn "foo bar" src',
  "grep -E 'a|b$' src/x.ts",
  'grep -rn foo --include=x.ts src',
  "grep -rn foo --include='*.ts' src",
  'rg -n foo',
  "rg -n 'foo\\(' -g '*.ts' src",
  'rg --files',
  "find . -name '*.ts' -type f",
  'find src -maxdepth 2 -type d',
  "find . -name '*.md' -not -path './node_modules/*'",
  'git log --oneline',
  'git log --oneline -5',
  'git log -n 3 --stat',
  'git diff --stat',
  'git diff HEAD~1 -- src/x.ts',
  'git show HEAD:src/x.ts',
  'git status --short',
  'git branch -vv',
  'git rev-parse --show-toplevel',
  'head -n 20 f',
  'head -50 f',
  'tail -n 20 f',
  'wc -l f g',
  'sort -u f',
  'sort -rn f',
  'sort f | uniq -c | sort -rn | head -5',
  'uniq -c in',
  "jq '.x' package.json",
  "jq -r '.scripts | keys[]' package.json",
  'cat package.json 2>&1',
  'cat f 2> /dev/null',
  'pwd',
  'echo hola',
  'date +%Y-%m-%d',
  'date -u',
  'which node',
  'tree -L 2 src',
  'du -sh src',
  'diff -u a b',
  'file f',
  'stat f',
  'cut -d: -f1 f',
  "tr -d '\\r'",
  'basename src/x.ts .ts',
]

test('read-only shell check keeps the everyday reads', () => {
  expect(SHELL_READS.filter(command => !isReadOnlyShell(command))).toEqual([])
})

test('what a fork may call', () => {
  expect(forkMayCall('Read', {})).toBe(true)
  expect(forkMayCall('Grep', {})).toBe(true)
  expect(forkMayCall('Bash', { command: 'git log --oneline -5' })).toBe(true)
  expect(forkMayCall('Bash', { command: 'rm -rf build' })).toBe(false)
  expect(forkMayCall('Write', {})).toBe(false)
  expect(forkMayCall('Edit', {})).toBe(false)
  expect(forkMayCall('NotebookEdit', {})).toBe(false)
  expect(forkMayCall('Agent', {})).toBe(false)
  expect(forkMayCall('AskUserQuestion', {})).toBe(false)
  expect(forkMayCall('mcp__github__create_issue', {})).toBe(false)
  // A fork may read secrets (.env); a URL would carry them out.
  expect(forkMayCall('WebFetch', {})).toBe(false)
  expect(forkMayCall('WebSearch', {})).toBe(false)
})

const FORK_IDS = { plugin: 'decision-tree', key: 'forkIds' } as const

function agent(id: string, spawnedBy?: string): AgentInfo {
  return { id, description: 'Rama: x', type: 'fork', status: 'running', ...(spawnedBy === undefined ? {} : { spawnedBy }) }
}

/** Runs a tool call as the engine would; resolves the deny reason, or null when the call went through. */
async function call($: EngineInterface, input: Record<string, unknown>): Promise<string | null> {
  const r = (await $.tool.call({ tool_use_id: `t-${Math.random()}`, ...input } as never)) as { deny?: string; text?: string }
  if (typeof r.deny === 'string') return r.deny
  expect(r.text, JSON.stringify(r)).toBe('ok')
  return null
}

const WRITE = { tool: 'Write', file_path: '/x', content: 'y' }

test('the guard holds a fork this plugin started', async ($, on) => {
  const seen = world(on)
  // The kit drops an agentId a test spawn makes up and answers state reads
  // itself, so the fork's id reaches forkIds the other way the guard learns
  // it: the agent list naming this plugin as the one that spawned it.
  const written: unknown[] = []
  on('state.set', (_$, e, next) => {
    if (e.plugin === FORK_IDS.plugin && e.key === FORK_IDS.key) written.push(e.value)
    return next(e)
  })
  seen.agents = [agent('fork-9', 'decision-tree')]
  expect(await call($, { ...WRITE, agentId: 'fork-9' })).toContain('rama de prueba')
  expect(written.at(-1)).toEqual(['fork-9'])

  // Gone from the list (a finished agent leaves it), the id in forkIds still holds it.
  seen.agents = []
  expect(await call($, { tool: 'Edit', agentId: 'fork-9', file_path: '/x', old_string: 'a', new_string: 'b' })).not.toBe(null)
  expect(await call($, { tool: 'Bash', agentId: 'fork-9', command: 'rm -rf build' })).not.toBe(null)
  expect(await call($, { tool: 'Bash', agentId: 'fork-9', command: "find . '-delete'" })).not.toBe(null)
  expect(await call($, { tool: 'WebFetch', agentId: 'fork-9', url: 'https://example.com', prompt: 'x' })).not.toBe(null)

  expect(await call($, { tool: 'Bash', agentId: 'fork-9', command: 'ls -la' })).toBe(null)
  expect(await call($, { tool: 'Read', agentId: 'fork-9', file_path: '/x' })).toBe(null)
  // The main loop and other subagents keep every tool.
  expect(await call($, WRITE)).toBe(null)
  expect(await call($, { ...WRITE, agentId: 'other' })).toBe(null)
})

test('the guard holds a fork whose spawn has not resolved yet', async ($, on) => {
  const seen = world(on)
  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.opened > 0)

  let release = () => {}
  seen.spawnGate = new Promise<void>(resolve => {
    release = resolve
  })
  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  const pressing = ui.press({ key: 'try' })
  await settle($, () => seen.spawns.length > 0)

  // The fork runs before its id comes back: not listed yet, or listed as ours.
  expect(await call($, { ...WRITE, agentId: 'fork-new' })).not.toBe(null)
  seen.agents = [agent('fork-new', 'decision-tree'), agent('model-sub'), agent('other-plugin-sub', 'someone-else')]
  expect(await call($, { tool: 'Bash', agentId: 'fork-new', command: 'rm -rf build' })).not.toBe(null)

  // Subagents someone else started keep every tool meanwhile.
  expect(await call($, { ...WRITE, agentId: 'model-sub' })).toBe(null)
  expect(await call($, { ...WRITE, agentId: 'other-plugin-sub' })).toBe(null)

  release()
  await pressing
  await ui.unmount()
})

test("the guard holds any fork listed as this plugin's, however old", async ($, on) => {
  const seen = world(on)
  seen.agents = [agent('old-fork', 'decision-tree')]
  expect(await call($, { ...WRITE, agentId: 'old-fork' })).not.toBe(null)

  // With no spawn under way, an agent nobody lists is not this plugin's.
  expect(await call($, { ...WRITE, agentId: 'workflow-agent' })).toBe(null)
})

test('when the guard cannot look an agent up, it refuses only while a fork may be starting', async ($, on) => {
  const seen = world(on)
  seen.isListFailing = true
  // No spawn under way: another plugin's or the model's subagent keeps working.
  expect(await call($, { ...WRITE, agentId: 'model-sub' })).toBe(null)

  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.opened > 0)
  let release = () => {}
  seen.spawnGate = new Promise<void>(resolve => {
    release = resolve
  })
  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  const pressing = ui.press({ key: 'try' })
  await settle($, () => seen.spawns.length > 0)
  expect(await call($, { ...WRITE, agentId: 'maybe-the-fork' })).not.toBe(null)

  release()
  await pressing
  await ui.unmount()
})

test('a custom answer joins the options and gets analysed', async ($, on) => {
  const seen = world(on)
  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.opened > 0)

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  await ui.input({ key: 'custom', text: 'Usa DuckDB.' })
  expect(await ui.find({ key: 'opt-2' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', key: 'implication' })).toBeDefined()
  await ui.unmount()
})

const ASKED = [
  {
    question: '¿Qué base de datos?',
    header: 'Base',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'Servidor aparte, más potente.' },
      { label: 'SQLite', description: 'Un archivo, cero operación.' },
    ],
  },
  {
    question: '¿Con ORM?',
    header: 'ORM',
    multiSelect: false,
    options: [
      { label: 'Sí', description: 'Drizzle.' },
      { label: 'No', description: 'SQL a mano.' },
    ],
  },
]

test('an AskUserQuestion call moves to the panel and is answered by clicks', async ($, on) => {
  const seen = world(on)
  const asked = await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'ask-1', questions: ASKED } as never)
  expect('deny' in asked && typeof asked.deny === 'string' && asked.deny.includes('panel')).toBe(true)
  expect(seen.opened).toBe(1)
  expect(seen.completes).toBe(0)

  // While it waits in the panel, the model's closing words do not replace it.
  await complete($, 'Te espero en el panel. ¿Algo más?')
  expect(seen.completes).toBe(0)

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Servidor aparte/ })).toBeDefined()
  await ui.press({ key: 'opt-1' })
  expect(await ui.find({ type: 'Text', text: /Un archivo/ })).toBeDefined()
  await ui.press({ key: 'q-1' })
  expect(await ui.find({ type: 'Text', text: /Con ORM/ })).toBeDefined()
  await ui.press({ key: 'opt-1' })
  await ui.press({ key: 'send' })
  expect(seen.submits.at(-1)).toBe('Mis respuestas:\n- ¿Qué base de datos? → SQLite\n- ¿Con ORM? → No')
  await ui.unmount()
})

test('a subagent AskUserQuestion keeps the native dialog', async ($, on) => {
  const seen = world(on)
  const asked = await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'ask-2', agentId: 'sub', questions: ASKED } as never)
  expect('deny' in asked && asked.deny !== undefined).toBe(false)
  expect(seen.opened).toBe(0)
})

test('answers compose per source', () => {
  const questions = fromToolQuestions(ASKED) ?? []
  expect(questions.length).toBe(2)
  expect(composeAnswer({ id: 'x', source: 'tool', context: '', questions }, { 0: 0 })).toBe(
    'Mis respuestas:\n- ¿Qué base de datos? → Postgres\n- ¿Con ORM? → Sí',
  )
  const one = [{ text: '¿Sigo?', options: [{ label: 'Sí', reply: 'Sí, sigue.' }] }]
  expect(composeAnswer({ id: 'y', source: 'text', context: '', questions: one }, {})).toBe('Sí, sigue.')
})

test('the handed-off dialog draws as a card, and the panel draws on each surface', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'ask-3', questions: ASKED } as never)
  expect(seen.opened).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'decision-tree',
      surface,
      component: 'ToolUse',
      requestId: 'ask-3',
      props: {
        tool_use_id: 'ask-3',
        tool: 'AskUserQuestion',
        input: { questions: ASKED },
        isRunning: false,
        isErrored: true,
        isInterrupted: false,
        output: '<tool_use_error>[decision-tree] La persona va a decidir…</tool_use_error>',
      },
    } as never)
    expect(await row.find({ type: 'Text', text: /preguntas en el panel lateral/ })).toBeDefined()
    await row.unmount()

    const pane = await $.ui.mount({ plugin: 'decision-tree', surface, ...PANE })
    expect(await pane.find({ key: 'opt-0' })).toBeDefined()
    expect(await pane.find({ key: 'send' })).toBeDefined()
    await pane.unmount()
  }
})

// Waits for a condition read asynchronously, as a drawing's elements are.
async function until(ready: () => Promise<boolean>) {
  for (let i = 0; i < 500; i += 1) {
    if (await ready()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('never happened')
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function gate() {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  return { held, release }
}

test('an analysis that fails says so instead of loading forever', async ($, on) => {
  const seen = world(on)
  seen.isForkFailing = true
  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.forkCalls > 0)

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  await until(async () => (await ui.find({ type: 'Markdown', key: 'implication' })) !== undefined)
  expect((await ui.find({ type: 'Markdown', key: 'implication' }))?.text).toContain('No se pudo analizar')
  expect(await ui.find({ type: 'Text', text: /Analizando/ })).toBe(undefined)
  await ui.unmount()
})

test('a double press starts one analysis and one fork', async ($, on) => {
  const seen = world(on)
  const analysis = gate()
  seen.forkGate = analysis.held
  await complete($, '¿Lo hago con Postgres o con SQLite?')
  await settle($, () => seen.forkCalls === 1)

  const ui = await $.ui.mount({ plugin: 'decision-tree', surface: 'terminal', ...PANE })
  const choosing = Promise.all([ui.press({ key: 'opt-1' }), ui.press({ key: 'opt-1' })])
  await settle($, () => seen.forkCalls >= 2)
  await pause(20)
  expect(seen.forkCalls).toBe(2)
  analysis.release()
  await choosing

  const start = gate()
  seen.spawnGate = start.held
  const trying = Promise.all([ui.press({ key: 'try' }), ui.press({ key: 'try' })])
  await settle($, () => seen.spawns.length >= 1)
  await pause(20)
  expect(seen.spawns.length).toBe(1)
  start.release()
  await trying
  await ui.unmount()
})

test('a dialog the pane cannot take keeps the native dialog and analyses nothing', async ($, on) => {
  const seen = world(on)
  seen.isPlaced = false
  const asked = await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'ask-9', questions: ASKED } as never)
  expect('deny' in asked && asked.deny !== undefined).toBe(false)
  await pause(20)
  expect(seen.forkCalls).toBe(0)
})
