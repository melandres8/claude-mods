import { expect, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

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
  const seen = { spawns: [] as string[], submits: [] as string[], completes: 0, opened: 0 }
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('model.complete', () => {
    seen.completes += 1
    return { value: { isAnswered: true, text: JSON.stringify(QUESTION), usage: usage() } } as never
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: '**Qué harías después**: migrar.', usage: usage() } }) as never)
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: true } } as never
  })
  on('agent.spawn', (_$, e) => {
    seen.spawns.push(e.prompt)
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
  const mainWrite = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/x', content: 'y' } as never)
  expect(mainWrite.isError).toBeFalsy()
  const otherWrite = await $.tool.call({ tool: 'Write', tool_use_id: 'w2', agentId: 'other', file_path: '/x', content: 'y' } as never)
  expect(otherWrite.isError).toBeFalsy()

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
