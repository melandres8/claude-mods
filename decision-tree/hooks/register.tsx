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
// Every fork this plugin started, never reset, so the guard below keeps
// holding a fork that outlives the ask it was started for.
const forkIds = atom({ plugin: 'decision-tree', key: 'forkIds' } as const, [])

// What the last drawing said about the layout; unknown until the pane draws.
let isFullscreen: boolean | undefined

// What a fork may call: reading and looking things up, nothing that changes
// the workspace. Bash is judged per command by isReadOnlyShell.
const FORK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ToolSearch'])

const SHELL_READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'echo', 'which', 'file',
  'stat', 'tree', 'du', 'df', 'date', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'jq',
  'basename', 'dirname', 'realpath', 'true',
])
const GIT_READERS = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'describe'])
const GIT_LISTING_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current'])

function isReadOnlyStep(step: string): boolean {
  const words = step.split(/\s+/)
  const [bin = '', sub = ''] = words
  const rest = words.slice(2)
  if (/\s(-o|--output)(\s|=|$)/.test(step)) return false
  if (bin === 'git') {
    if (sub === 'branch' || sub === 'remote') return rest.every(flag => GIT_LISTING_FLAGS.has(flag))
    return GIT_READERS.has(sub)
  }
  if (bin === 'find') return !/\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/.test(step)
  if (bin === 'uniq') return words.slice(1).filter(word => !word.startsWith('-')).length <= 1

  return SHELL_READERS.has(bin)
}

export function isReadOnlyShell(command: string): boolean {
  const cleaned = command.replace(/\s2>&1/g, '').replace(/\s2>\s*\/dev\/null/g, '')
  if (/[>`]|\$\(|<\(/.test(cleaned)) return false

  return cleaned
    .split(/&&|\|\||[;&|\n]/)
    .map(step => step.trim())
    .filter(step => step.length > 0)
    .every(isReadOnlyStep)
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

/** Seats a new ask, clearing the last one's analysis and forks; resolves whether the pane is drawn. */
async function present($: EngineInterface, next: DecisionAsk, isAsked: boolean) {
  await update($, ask, () => next)
  await update($, focus, () => 0)
  await update($, picks, () => ({}))
  await update($, implications, () => ({}))
  await update($, forks, () => ({}))
  await update($, phase, () => 'ready')
  const count = next.questions.length > 1 ? `${next.questions.length} preguntas` : 'una pregunta'
  $.ui.status(`decision-tree: ${count} para explorar · /decision-tree`)

  // Unasked, open only where the pane docks beside the transcript; on the
  // main screen it would open inline, so the status line points to it instead.
  const shouldOpen = isAsked || isFullscreen !== false
  const isPlaced = shouldOpen ? (await $.ui.open({ id: PANE, title: TITLE })).isPlaced : false
  void imply($, next.id, 0, 0)
  return isPlaced
}

async function readQuestion($: EngineInterface, answer: string, turnId: string) {
  await update($, phase, () => 'reading')
  const reply = await $.model.complete({ model: 'haiku', prompt: ASK_PROMPT(answer), maxTokens: 800 })
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

async function imply($: EngineInterface, id: string, qi: number, oi: number) {
  const a = await current($, id)
  const q = a?.questions[qi]
  const option = q?.options[oi]
  const slot = slotOf(id, qi, oi)
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

async function branch($: EngineInterface, id: string, qi: number, oi: number) {
  const a = await current($, id)
  const q = a?.questions[qi]
  const option = q?.options[oi]
  const slot = slotOf(id, qi, oi)
  if (a === null || q === undefined || option === undefined) return
  const existing = (await read($, forks))[slot]
  if (existing !== undefined && existing.status !== 'error') return

  const setFork = (fork: DecisionFork) => update($, forks, all => ({ ...all, [slot]: fork }))
  await setFork({ status: 'starting', text: '' })
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
    await update($, forkIds, ids => [...ids, agentId].slice(-100))
    await setFork({ status: 'running', agentId, text: '' })
  } catch (error) {
    await setFork({ status: 'error', text: `La rama no arrancó: ${String(error)}` })
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
      const ids = await read($, forkIds)
      if (ids.includes(e.agentId)) {
        const agentId = e.agentId
        const all = await read($, forks)
        const slot = Object.keys(all).find(key => all[key]?.agentId === agentId)
        if (slot !== undefined) {
          const done: DecisionFork =
            e.reason === 'answer'
              ? { status: 'done', agentId, text: e.answer }
              : { status: 'error', agentId, text: `La rama terminó sin respuesta (${e.reason}).` }
          await update($, forks, now => ({ ...now, [slot]: done }))
          $.ui.toast('decision-tree: rama lista, mírala en el panel')
        }
      }
      return next(e)
    }

    // An AskUserQuestion handed to the panel stays until it is answered.
    const pending = await read($, ask)
    if (pending?.source === 'tool') return next(e)

    if (e.reason === 'answer' && endsWithQuestion(e.answer)) {
      void readQuestion($, e.answer, e.turnId).catch(() => update($, phase, () => 'none'))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A fork's completion would otherwise wake the main conversation with its
    // report before the person chose anything; the panel shows it instead.
    if (e.origin?.kind === 'task-notification') {
      const ids = await read($, forkIds)
      if (ids.some(id => e.text.includes(id))) {
        return { drop: 'decision-tree: la rama terminó; su informe está en el panel (/decision-tree).' }
      }
      return next(e)
    }
    // The person answered on their own: a dialog handed to the panel is settled.
    if (e.origin === undefined || e.origin.kind === 'composer') {
      if ((await read($, ask))?.source === 'tool') await settle($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    if (!(await read($, forkIds)).includes(e.agentId)) return next(e)

    const tool = String(e.tool)
    if (forkMayCall(tool, { command: 'command' in e ? e.command : undefined })) return next(e)

    return {
      deny: `decision-tree: esta es una rama de prueba; ${tool} no está permitido aquí. Describe el cambio en tu informe en lugar de aplicarlo.`,
    }
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined
      ? next(e)
      : { deny: 'decision-tree: no se pudo comprobar si esta llamada viene de una rama de prueba.' },
  )

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
    const width = e.props.bodyColumns

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
    const allForks = await read($, forks)
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
      </Box>
    )
  })
}
