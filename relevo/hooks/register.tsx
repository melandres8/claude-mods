import { atom, read, update } from 'claude-code'
import type {
  Color,
  ElementConstructor,
  EngineInterface,
  Register,
  SessionReceiveOrigin,
  TextProps,
  Timer,
} from 'claude-code'

import type { RelevoHeld, RelevoLink, RelevoPeer, RelevoPeerLink, RelevoRole, RelevoTurn } from '../types'
import {
  address,
  ago,
  bar,
  extractHandoffs,
  extractTag,
  header,
  isWorkerName,
  linkAsk,
  linkOk,
  looksLikeHeader,
  looksLikeLink,
  parseHeader,
  parseLink,
  preview,
  sameText,
  stripHeader,
  unwrap,
} from './relay'

// New keys for the hub's state: a session left with 0.2's `role` and
// `pending` by a hot reload comes up with no role, to be linked again.
const role = atom({ plugin: 'relevo', key: 'hubRole' } as const, null)
// This session's peers by their role: a worker's one `planner`, a planner's
// one entry per worker name.
const links = atom({ plugin: 'relevo', key: 'links' } as const, {})
const round = atom({ plugin: 'relevo', key: 'round' } as const, 0)
const paused = atom({ plugin: 'relevo', key: 'paused' } as const, false)
const isDone = atom({ plugin: 'relevo', key: 'isDone' } as const, false)
const pending = atom({ plugin: 'relevo', key: 'held' } as const, [])
const cap = atom({ plugin: 'relevo', key: 'cap' } as const, null)
const goal = atom({ plugin: 'relevo', key: 'goal' } as const, null)
const turn = atom({ plugin: 'relevo', key: 'turn' } as const, null)
const lastError = atom({ plugin: 'relevo', key: 'lastError' } as const, null)
const invite = atom({ plugin: 'relevo', key: 'invite' } as const, null)
const inbox = atom({ plugin: 'relevo', key: 'inbox' } as const, null)
const lastPane = atom({ plugin: 'relevo', key: 'lastPane' } as const, null)
const spawnCount = atom({ plugin: 'relevo', key: 'spawnCount' } as const, 0)
// What the pane's fields hold until the person presses a button.
const draftRole = atom({ plugin: 'relevo', key: 'draftRole' } as const, 'planner')
const draftPeer = atom({ plugin: 'relevo', key: 'draftPeer' } as const, null)
const draftGoal = atom({ plugin: 'relevo', key: 'draftGoal' } as const, '')
const peers = atom({ plugin: 'relevo', key: 'peers' } as const, [])

const PANE = 'relevo'

// The worker an untagged <handoff> goes to, and the key a planner's manual
// link waits under until the worker's ack names it.
const DEFAULT_WORKER = 'builder'

// Theme keys, so the colors follow the person's theme.
const colorOf = (name: RelevoRole): Color => (name === 'planner' ? 'planMode' : 'autoAccept')

function promptOf(name: RelevoRole, maxWorkers: number, workers: string[]): string {
  if (name === 'planner') {
    return [
      '# relevo: planner',
      'Divides el objetivo en pasos pequeños y verificables. NO editas código.',
      'Repartes el trabajo entre workers con un nombre que diga lo que hacen: builder construye, researcher investiga, reviewer revisa, o el que encaje (minúsculas, letras, dígitos, - o _, hasta 32).',
      'Para mandar un paso, termina tu respuesta con <handoff to="nombre">…</handoff>. Puedes poner varios bloques, uno por worker; un <handoff> sin to va a builder.',
      `Si el worker no existe, relevo lo crea con ese nombre. Máximo ${maxWorkers} workers; ahora: ${workers.length === 0 ? 'ninguno' : workers.join(', ')}.`,
      'Cuando el objetivo esté cumplido, emite <done>resumen</done>.',
      'Reparte en paralelo lo que no dependa entre sí: un bloque por worker en la misma respuesta.',
      'Los mensajes que empiezan con "[relevo ronda N · de <nombre>]" son el informe de ese worker. relevo te pasa juntos los informes de todos los workers a los que diste trabajo, cuando ha respondido el último: revísalos y decide el siguiente paso.',
    ].join('\n')
  }
  if (name === 'builder') {
    return [
      '# relevo: builder',
      'Ejecutas exactamente el paso recibido.',
      'Al terminar, cierra con un <handoff> que traiga qué hiciste, qué archivos tocaste, el resultado de los tests y tus dudas.',
      'Los mensajes que empiezan con "[relevo ronda N · de planner]" son el paso que te manda el planificador.',
    ].join('\n')
  }

  return [
    `# relevo: ${name}`,
    `Eres el worker "${name}" de un planificador: haces exactamente la tarea recibida, en el papel que tu nombre indica.`,
    'Al terminar, cierra con un <handoff> que traiga qué hiciste, qué encontraste, qué archivos tocaste si tocaste alguno, y tus dudas.',
    'Los mensajes que empiezan con "[relevo ronda N · de planner]" son la tarea que te manda el planificador.',
  ].join('\n')
}

const USAGE = [
  '/relevo                     abre el panel',
  '/relevo planner [<peer>]    esta sesión planifica; sin <peer>, en herdr crea sus workers',
  '/relevo builder <peer>      esta sesión construye',
  '/relevo join <nombre> <peer> esta sesión es el worker <nombre> (researcher, reviewer, ...)',
  '/relevo goal <texto>        (planner) arranca el ciclo',
  '/relevo pause | resume      corta o reanuda el envío automático',
  '/relevo status              rol, peers, ronda, último envío e id de esta sesión',
  '/relevo off                 quita el rol',
].join('\n')

type $ = EngineInterface
type Opts = { maxRounds: number; maxWorkers: number }
type Links = Record<string, RelevoPeerLink>

// Whether a session in role `self` pairs with one in role `them`: a planner
// with any worker, a worker with the planner.
const fits = (self: RelevoRole, them: RelevoRole) => (self === 'planner') !== (them === 'planner')

// The verb that accepts an ask from `from`.
const acceptVerb = (from: RelevoRole) => (from === 'planner' ? DEFAULT_WORKER : 'planner')

const blankLink = (peer: string, extra: Partial<RelevoPeerLink> = {}): RelevoPeerLink => ({
  peer,
  nonce: null,
  link: 'none',
  spawned: false,
  isBusy: false,
  lastSent: null,
  lastSentAt: null,
  lastReceived: null,
  lastReceivedAt: null,
  ...extra,
})

// A session id is long; the drawing shows its first part. Names stay whole.
function short(name: string | null): string {
  if (name === null) return '?'
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)) return name.slice(0, 8)

  return name.startsWith('session_') ? name.slice(0, 16) : name
}

// A worker this planner started goes by its name; any other peer by its
// address, as the person typed or picked it.
const labelOf = (key: string, one: RelevoPeerLink, isShort = true) =>
  one.spawned ? key : isShort ? short(one.peer) : one.peer

async function setLink($: $, key: string, patch: Partial<RelevoPeerLink> & { peer?: string }) {
  await update($, links, (all: Links) => ({ ...all, [key]: { ...(all[key] ?? blankLink(patch.peer ?? '')), ...patch } }))
}

async function dropLink($: $, key: string) {
  await update($, links, (all: Links) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key)))
}

// A planner's manual link waits under DEFAULT_WORKER; the ack, or the first
// round, names the worker. Moves the entry and its held handoffs there.
async function renameLink($: $, from: string, to: string): Promise<string> {
  const all: Links = await read($, links)
  if (from === to || all[from] === undefined || all[to] !== undefined) {
    return from
  }
  await update($, links, (now: Links) =>
    Object.fromEntries(Object.entries(now).map(([name, one]) => [name === from ? to : name, one])),
  )
  await update($, pending, (held: RelevoHeld[]) => held.map(one => (one.to === from ? { ...one, to } : one)))

  return to
}

async function showStatus($: $) {
  const current = await read($, role)
  $.ui.status(current === null ? undefined : `relevo: ${current}`)
}

async function pause($: $, why: string) {
  await update($, paused, () => true)
  $.ui.toast(`relevo: ${why}`)
}

async function limitOf($: $, maxRounds: number): Promise<number> {
  return (await read($, cap)) ?? maxRounds
}

// One held handoff per peer: a later one replaces it.
async function hold($: $, item: RelevoHeld) {
  await update($, pending, (held: RelevoHeld[]) => [...held.filter(one => one.to !== item.to), item])
}

async function release($: $, to: string) {
  await update($, pending, (held: RelevoHeld[]) => held.filter(one => one.to !== to))
}

// Sends one handoff under round n, or holds it: 'sent', or why it is held.
// A planner's handoff to a worker it has not got starts that worker.
async function sendOne($: $, opts: Opts, current: RelevoRole, item: RelevoHeld, n: number): Promise<string> {
  const all: Links = await read($, links)
  const one = all[item.to]
  if (one === undefined) {
    // Keeps the round this turn would take: it goes out under it once linked.
    await hold($, { ...item, round: n })

    return current === 'planner' ? await spawnWorker($, opts, item.to) : 'sin rol'
  }
  // Only to a peer that accepted this pairing: a clash of roles, or an ask
  // nobody accepted, never relays. A worker being started links on its own.
  if (one.link !== 'linked' || one.nonce === null) {
    await hold($, one.spawned ? { ...item, round: n } : item)
    if (one.spawned) {
      return `esperando a ${item.to}`
    }
    await pause($, `sin enlace con ${labelOf(item.to, one)}; el handoff queda retenido. Cuando acepte, /relevo resume lo envía.`)

    return 'sin enlace'
  }

  let reason: string | null = null
  try {
    const sent = await $.session.send({ to: address(one.peer), text: `${header(n, current, one.nonce)}\n\n${item.body}` })
    if (!sent.isDelivered) reason = sent.reason
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  if (reason !== null) {
    await hold($, item)
    await update($, lastError, () => `no se pudo entregar: ${reason}`)
    await pause($, `no se pudo entregar a ${labelOf(item.to, one, false)}: ${reason}. En pausa.`)

    return reason
  }

  const now = await $.clock.now()
  await setLink($, item.to, { lastSent: item.body, lastSentAt: now, isBusy: true })
  await release($, item.to)
  await update($, lastError, () => null)

  return 'sent'
}

// Sends the handoffs of one model turn, or a resume's held ones, as one
// round: a planner's fan-out to three workers counts once against the cap,
// which holds on both sides so neither one alone can loop.
async function dispatch($: $, opts: Opts, items: RelevoHeld[]): Promise<string> {
  const current = await read($, role)
  if (current === null || (current !== 'planner' && Object.keys(await read($, links)).length === 0)) {
    return 'sin rol'
  }
  const limit = await limitOf($, opts.maxRounds)
  const n = current === 'planner' ? (await read($, round)) + 1 : Math.max(1, await read($, round))
  if (n > limit) {
    for (const item of items) await hold($, item)
    await pause($, `llegó a ${limit} rondas; en pausa (/relevo resume para seguir).`)

    return 'límite de rondas'
  }
  const outcomes: string[] = []
  let isSent = false
  for (const item of items) {
    const outcome = await sendOne($, opts, current, item, n)
    // A worker being started takes this round when it links (flush), so a
    // failed start burns none.
    if (outcome === 'sent') isSent = true
    const named = items.length > 1 ? ` a ${item.to}` : ''
    outcomes.push(outcome === 'sent' ? `ronda ${n} enviada${named}` : `${item.to}: ${outcome}`)
  }
  if (isSent) {
    await update($, round, () => n)
    await update($, turn, () => 'peer')
  }

  return outcomes.join('; ')
}

// The shell that opens a worker: a herdr pane beside this one (or below the
// last worker's), Claude in it under the worker's name and a session id this
// planner chose, then the worker's own /relevo join back to this session.
// Every interpolated value is checked by the caller (a worker name, a uuid,
// this session's id, a herdr pane id) or single-quoted (the project root:
// the shell's own $PWD follows the model's cd).
export function spawnScript(
  name: string,
  id: string,
  plannerId: string,
  cwd: string,
  from: string | null,
  direction: 'right' | 'down',
) {
  const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`
  const join = `'/relevo join ${name} ${plannerId}'`

  return [
    // The Herdr app's terminals (HC_*) run in herdr-core, driven by `hc`, not
    // the TUI's `herdr` CLI. The worker takes this terminal's space and tab
    // labels, so the app shows it in this tab; its first prompt is the join.
    'if [ "${HERDR_ENV:-}" != 1 ] && [ -n "${HC_TERMINAL_ID:-}" ] && command -v hc >/dev/null 2>&1; then',
    '  me=$(hc get "$HC_TERMINAL_ID" --json) || { echo "hc no responde: $me" >&2; exit 4; }',
    `  space=$(printf '%s' "$me" | grep -o '"herdr.space": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')`,
    `  tab=$(printf '%s' "$me" | grep -o '"herdr.tab": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')`,
    `  out=$(hc run --bg --json --no-notify --name ${name} --cwd ${quoted} \${space:+"--label=herdr.space=$space"} \${tab:+"--label=herdr.tab=$tab"} -- claude --name ${name} --session-id ${id} ${join} 2>&1) || { echo "hc no abrió el worker: $out" >&2; exit 5; }`,
    `  t=$(printf '%s' "$out" | grep -o '"address": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')`,
    '  echo "pane=$t"; exit 0',
    'fi',
    'test "${HERDR_ENV:-}" = 1 || { echo "esta sesión no corre en Herdr: ni en la app (hc) ni en un pane del TUI (herdr)" >&2; exit 3; }',
    `target=${from === null ? '"$HERDR_PANE_ID"' : `'${from}'`}`,
    `split=$(herdr pane split --pane "$target" --direction ${direction} --cwd ${quoted} --no-focus \${CLAUDE_CODE_PLUGIN_DIRS:+"--env=CLAUDE_CODE_PLUGIN_DIRS=$CLAUDE_CODE_PLUGIN_DIRS"}) || { echo "herdr no abrió el pane: $split" >&2; exit 4; }`,
    `pane=$(printf '%s' "$split" | grep -o '"pane_id": *"[^"]*"' | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')`,
    'test -n "$pane" || { echo "herdr no devolvió el pane: $split" >&2; exit 4; }',
    `herdr agent start ${name} --kind claude --pane "$pane" -- --name ${name} --session-id ${id} >&2 || { herdr pane close "$pane" >/dev/null 2>&1; exit 5; }`,
    `herdr agent prompt ${name} ${join} >&2 || exit 6`,
    'echo "pane=$pane"',
  ].join('\n')
}

// Starts a worker the planner named. Its entry waits under a session id of
// this planner's choosing, and only that id's ask links it (answerLink). The
// shell runs from a timer: a hook awaiting a permission dialog would stall.
async function spawnWorker($: $, opts: Opts, name: string): Promise<string> {
  const self = await $.session.id()
  const fail = async (why: string) => {
    await update($, lastError, () => why)
    await pause($, `${why} El handoff queda retenido; /relevo resume lo reintenta.`)

    return why
  }
  if (!isWorkerName(name)) {
    return await fail(`"${name}" no sirve como nombre de worker.`)
  }
  if (Object.keys(await read($, links)).length >= opts.maxWorkers) {
    return await fail(`ya hay ${opts.maxWorkers} workers (maxWorkers); no se crea ${name}.`)
  }
  if (!/^[\w-]+$/.test(self)) {
    return await fail('el id de esta sesión no es apto para herdr.')
  }
  const id = crypto.randomUUID()
  await setLink($, name, blankLink(id, { spawned: true, link: 'waiting' }))
  $.clock.after(0, () => void runSpawn($, name, id, self))

  return `creando ${name}`
}

async function runSpawn($: $, name: string, id: string, self: string) {
  const from = await read($, lastPane)
  const count = await read($, spawnCount)
  const script = spawnScript(
    name,
    id,
    self,
    await $.session.root(),
    from !== null && /^[\w:]+$/.test(from) ? from : null,
    count % 2 === 0 ? 'right' : 'down',
  )
  let why: string | null = null
  try {
    const called = await $.tool.call({
      tool: 'Bash',
      command: script,
      description: `Abre el worker ${name} de relevo en un pane de herdr`,
      timeout: 120000,
    })
    if (called.deny !== undefined) {
      why = `no se permitió abrir ${name}: ${called.deny}`
    } else if (called.isError === true) {
      why = `no se pudo abrir ${name}: ${(called.text ?? 'error de herdr').trim().split('\n').slice(-3).join(' · ')}`
    } else {
      const pane = /pane=(\S+)/.exec(called.result.stdout)?.[1] ?? null
      await update($, lastPane, () => pane)
      await update($, spawnCount, n => n + 1)
      $.ui.toast(`relevo: ${name} arrancó en herdr${pane === null ? '' : ` (${pane})`}; esperando su enlace.`)
      // A worker whose /relevo join never ran (relevo not loaded there, the
      // prompt not taken) would wait silently: say so after a while.
      $.clock.after(JOIN_WAIT_MS, () => void stalled($, name, id))
    }
  } catch (error) {
    why = `no se pudo abrir ${name}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (why !== null) {
    const current: Links = await read($, links)
    // Only the entry this run made: a later relevo off or respawn is left alone.
    if (current[name]?.peer === id) await dropLink($, name)
    await update($, lastError, () => why)
    await pause($, `${why} El handoff queda retenido; /relevo resume lo reintenta.`)
  }
}

const JOIN_WAIT_MS = 90_000

async function stalled($: $, name: string, id: string) {
  const one = ((await read($, links)) as Links)[name]
  if (one?.peer !== id || one.link !== 'waiting') {
    return
  }
  const why = `${name} no se enlazó; mira su terminal (hc read ${name} en la app, herdr agent read ${name} en el TUI). ¿Carga relevo y aceptó /relevo join?`
  await update($, lastError, () => why)
  await pause($, why)
}

async function reset($: $) {
  await update($, round, () => 0)
  await update($, cap, () => null)
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, pending, () => [])
  await update($, inbox, () => null)
  await update($, lastError, () => null)
  await update($, turn, () => null)
  await update($, links, (all: Links) =>
    Object.fromEntries(
      Object.entries(all).map(([name, one]) => [name, { ...one, lastSent: null, lastSentAt: null, isBusy: false }]),
    ),
  )
}

type Tone = Color
type LivePeer = { key: string; label: string; link: RelevoLink; isBusy: boolean }
type Live = {
  current: RelevoRole
  peers: LivePeer[]
  n: number
  limit: number
  isPaused: boolean
  turn: RelevoTurn
  state: string
  tone: Tone
}

// What the band and the pane show on their status line; null without a role.
async function liveStatus($: $, maxRounds: number): Promise<Live | null> {
  const current = await read($, role)
  if (current === null) {
    return null
  }
  const all = Object.entries((await read($, links)) as Links)
  const shown = all.map(([key, one]) => ({ key, label: labelOf(key, one), link: one.link, isBusy: one.isBusy }))
  const busy = all.filter(([, one]) => one.isBusy)
  const at = busy.reduce<number | null>((last, [, one]) => Math.max(last ?? 0, one.lastSentAt ?? 0) || last, null)
  const isPaused = await read($, paused)
  const holder = await read($, turn)
  const failed = await read($, lastError)
  const isWaiting = all.some(([, one]) => one.link === 'waiting')
  const [state, tone]: [string, Tone] = (await read($, isDone))
    ? ['terminado', 'merged']
    : failed !== null && isPaused
      ? ['en pausa · error', 'error']
      : isPaused
        ? ['en pausa', 'warning']
        : isWaiting && !all.some(([, one]) => one.link === 'linked')
          ? ['esperando enlace', 'suggestion']
          : holder === 'self'
            ? ['trabajando aquí', 'claude']
            : holder === 'peer' && at !== null && busy.length > 0
              ? [
                  `turno de ${busy.map(([key, one]) => labelOf(key, one)).join(', ')} · hace ${ago((await $.clock.now()) - at)}`,
                  'success',
                ]
              : current === 'planner'
                ? ['esperando objetivo', 'suggestion']
                : ['esperando paso', 'suggestion']

  return {
    current,
    peers: shown,
    n: await read($, round),
    limit: await limitOf($, maxRounds),
    isPaused,
    turn: holder,
    state,
    tone,
  }
}

// One row: a dot in the state's color, the role as a chip, the peers, the
// rounds as cells when the row is wide enough, and the state.
function liveLine(Text: ElementConstructor<TextProps>, live: Live | null, columns: number) {
  if (live === null) {
    return (
      <Text wrap="truncate-end">
        <Text color="claude" bold>
          relevo
        </Text>
        <Text dimColor> · sin rol</Text>
      </Text>
    )
  }
  const color = colorOf(live.current)
  const cells = columns >= 90 ? bar(live.n, live.limit, 10) : null

  return (
    <Text wrap="truncate-end">
      <Text color={live.tone}>● </Text>
      <Text color="claude" bold>
        relevo{' '}
      </Text>
      <Text backgroundColor={color} color="inverseText" bold>
        {` ${live.current.toUpperCase()} `}
      </Text>
      <Text color={color}> ⇄ </Text>
      {live.peers.length === 0 ? <Text dimColor>?</Text> : null}
      {live.peers.map((one, index) => (
        <Text key={one.key}>
          {index > 0 ? <Text dimColor>, </Text> : null}
          <Text bold color={one.isBusy ? colorOf(one.key) : undefined}>
            {one.label}
          </Text>
          {one.link === 'linked' ? <Text color="success"> ✓</Text> : null}
          {one.link === 'waiting' ? <Text color="warning"> …</Text> : null}
        </Text>
      ))}
      <Text dimColor> · ronda </Text>
      {cells !== null ? <Text color={color}>{cells.done}</Text> : null}
      {cells !== null ? <Text dimColor>{cells.left} </Text> : null}
      <Text bold>
        {live.n}/{live.limit}
      </Text>
      <Text dimColor> · </Text>
      <Text color={live.tone}>{live.state}</Text>
    </Text>
  )
}

type AgentListing = {
  sections?: { kind: string; rows: { name?: string; ref?: string; id?: string; status?: string }[] }[]
  notes?: { kind: string; text: string }[]
}

// The other sessions ListAgents lists, this one left out: it names itself in
// a note ("This session is <name> [<ref>]"), not by its session id. Empty on
// a deny, an error or a listing without sections.
async function listPeers($: $): Promise<RelevoPeer[]> {
  try {
    const called = await $.tool.call({ tool: 'ListAgents' })
    if (called.deny !== undefined || called.isError === true) {
      return []
    }
    const listing = called.result as AgentListing | undefined
    const self = await $.session.id()
    const selfNames = (listing?.notes ?? []).flatMap(note => {
      const match = /this session is (\S+)(?: \[(\w+)\])?/i.exec(note.text)

      return match === null ? [] : [match[1], match[2]].filter(name => name !== undefined)
    })
    const isSelf = (row: { name?: string; ref?: string; id?: string }) =>
      (row.id !== undefined && (row.id === self || self.startsWith(row.id))) ||
      (row.ref !== undefined && self.startsWith(row.ref)) ||
      selfNames.includes(row.name ?? '') ||
      selfNames.includes(row.ref ?? '')

    return (listing?.sections ?? [])
      .filter(section => !/self|this/i.test(section.kind))
      .flatMap(section => section.rows)
      .filter(row => row.name !== undefined && !isSelf(row))
      .map(row => ({ name: row.name ?? '', ref: row.ref, status: row.status }))
  } catch {
    return []
  }
}

async function loadPeers($: $) {
  const found = await listPeers($)
  await update($, peers, () => found)
}

// Opens the pane; undefined when it is drawn, so the command prints nothing.
// The peer list loads beside it, not awaited: ListAgents may ask permission.
async function openPane($: $): Promise<string | undefined> {
  void loadPeers($)
  const opened = await $.ui.open({ id: PANE, title: 'relevo', focus: true, closeOnEscape: true })

  return opened.isPlaced ? undefined : `el panel espera: ${opened.reason}`
}

async function sendQuiet($: $, to: string, text: string): Promise<boolean> {
  try {
    return (await $.session.send({ to: address(to), text })).isDelivered
  } catch {
    return false
  }
}

const isAnyLinked = (all: Links) => Object.values(all).some(one => one.link === 'linked')

// One function per /relevo verb, each returning the text the command shows.
// The command parses its arguments and calls these; a pane can call them too.

// Sets the role: the person's own act, the only one that binds a peer or
// sets a link's nonce. When the peer already asked for this pairing, it
// accepts that ask and acks with its nonce; otherwise it asks the peer with
// a fresh nonce, and the peer's person accepts there. A linked planner takes
// a further worker only by accepting that worker's ask.
async function setRole($: $, verb: RelevoRole, to: string): Promise<string> {
  const self = await $.session.id()
  const target = to.trim()
  if (target === self) {
    return 'el peer no puede ser esta misma sesión.'
  }
  const all: Links = await read($, links)
  const asked = await read($, invite)
  const accepting = asked !== null && asked.id === target && fits(verb, asked.from) ? asked : null
  const current = await read($, role)
  // A live link is changed only on purpose: a command from an old toast
  // would otherwise reset it under a new nonce the peer does not hold.
  if (current !== null && isAnyLinked(all)) {
    if (current === 'planner' && verb === 'planner' && accepting !== null && all[accepting.from] === undefined) {
      await setLink($, accepting.from, blankLink(target, { nonce: accepting.nonce, link: 'linked' }))
      await update($, invite, () => null)
      await sendQuiet($, target, linkOk('planner', accepting.nonce))

      return `enlazada con ${target}; worker ${accepting.from} añadido.`
    }

    return `ya enlazada con ${Object.values(all).map(one => one.peer).join(', ')}; /relevo off para cambiar.`
  }
  await update($, role, () => verb)
  await update($, links, () => ({}))
  await reset($)
  await update($, goal, () => null)
  await update($, invite, () => null)
  await showStatus($)
  const key = verb === 'planner' ? (accepting?.from ?? DEFAULT_WORKER) : 'planner'

  if (accepting !== null) {
    await setLink($, key, blankLink(target, { nonce: accepting.nonce, link: 'linked' }))
    await sendQuiet($, target, linkOk(verb, accepting.nonce))

    return `enlazada con ${target}; esta sesión es ${verb.toUpperCase()}.`
  }

  const fresh = crypto.randomUUID()
  const manual = `/relevo ${acceptVerb(verb)} ${self}`
  const sent = await sendQuiet($, target, linkAsk(verb, self, fresh))
  await setLink($, key, blankLink(target, { nonce: fresh, link: sent ? 'waiting' : 'none' }))

  return sent
    ? `esta sesión es ${verb.toUpperCase()} ⇄ ${target}. Enlace enviado; acéptalo en ${target} con: ${manual}`
    : `esta sesión es ${verb.toUpperCase()} ⇄ ${target}. No se pudo enviar el enlace.\nEn la otra sesión: ${manual}`
}

// A planner with no peer yet: in herdr its handoffs start the workers.
async function soloPlanner($: $): Promise<string> {
  if ((await read($, role)) !== null && isAnyLinked(await read($, links))) {
    return 'ya enlazada; /relevo off para cambiar.'
  }
  await update($, role, () => 'planner')
  await update($, links, () => ({}))
  await reset($)
  await update($, goal, () => null)
  await update($, invite, () => null)
  await showStatus($)

  return 'esta sesión es PLANNER, sin workers aún. En herdr, cada <handoff to="nombre"> abre ese worker en un pane. /relevo goal <texto> para empezar.'
}

// A command.run hook may not submit: the submit would wait on the turn the
// hook holds. A timer's callback runs once the command has ended.
function submitLater($: $, text: string) {
  $.clock.after(0, () => void $.prompt.submit({ text }))
}

async function startGoal($: $, maxRounds: number, text: string): Promise<string> {
  if ((await read($, role)) !== 'planner') {
    return '/relevo goal solo funciona en la planificadora (/relevo planner <peer>).'
  }
  if (text === '') {
    return 'Uso: /relevo goal <texto>'
  }
  await reset($)
  await update($, goal, () => text)
  await update($, turn, () => 'self')
  submitLater($, `Objetivo de relevo:\n\n${text}`)

  return `objetivo recibido, planificando (máximo ${maxRounds} rondas).`
}

async function pauseRelay($: $): Promise<string> {
  if ((await read($, role)) === null) {
    return 'no hay rol activo.'
  }
  await update($, paused, () => true)

  return 'en pausa.'
}

async function resumeRelay($: $, opts: Opts): Promise<string> {
  if ((await read($, role)) === null) {
    return 'no hay rol activo.'
  }
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, lastError, () => null)
  // A resume past the limit grants another maxRounds from here.
  const at = await read($, round)
  if (at >= (await limitOf($, opts.maxRounds))) {
    await update($, cap, () => at + opts.maxRounds)
  }
  // Reports held for workers that never answered: resume gives up on those.
  // They stop counting as busy, and one that never even linked is dropped,
  // so the next round neither waits on them nor holds their step again.
  if ((await read($, inbox)) !== null && (await read($, role)) === 'planner') {
    await update($, links, (all: Links) =>
      Object.fromEntries(
        Object.entries(all)
          .filter(([, one]) => !(one.spawned && one.link === 'waiting'))
          .map(([name, one]) => [name, { ...one, isBusy: false }]),
      ),
    )
  }
  const held: RelevoHeld[] = await read($, pending)
  const outcome = held.length === 0 ? '' : ` Pendiente: ${await dispatch($, opts, held)}.`
  // The peers' rounds that came in during the pause, now a turn for the model.
  const waiting = await read($, inbox)
  let handed = ''
  if (waiting !== null && !(await read($, paused))) {
    await update($, inbox, () => null)
    await update($, turn, () => 'self')
    submitLater($, waiting)
    handed = ' Ronda recibida pasada al modelo.'
  }

  return `reanudado (límite ${await limitOf($, opts.maxRounds)} rondas).${outcome}${handed}`
}

async function turnOff($: $): Promise<string> {
  await update($, role, () => null)
  await update($, links, () => ({}))
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, goal, () => null)
  await update($, turn, () => null)
  await update($, lastError, () => null)
  await update($, invite, () => null)
  await update($, inbox, () => null)
  await update($, pending, () => [])
  $.ui.status(undefined)

  return 'rol quitado; no se envía nada más. Los panes de herdr que relevo abrió siguen abiertos.'
}

// The pending link ask as one line, with the command that accepts it.
async function inviteLine($: $): Promise<string | null> {
  const asked = await read($, invite)

  return asked === null
    ? null
    : `${asked.id} pide enlazar como ${asked.from}. Si es tu otra sesión, acepta con: /relevo ${acceptVerb(asked.from)} ${asked.id}`
}

const LINK_WORDS: Record<RelevoLink, string> = {
  none: 'sin enlace',
  waiting: 'enlace enviado, sin respuesta',
  linked: 'enlazadas',
}

async function statusText($: $, maxRounds: number): Promise<string> {
  const current = await read($, role)
  const asked = await inviteLine($)
  if (current === null) {
    return [`sin rol. Esta sesión: ${await $.session.id()}`, ...(asked === null ? [] : [asked]), '', USAGE].join('\n')
  }
  const all = Object.entries((await read($, links)) as Links)
  const last = all
    .filter(([, one]) => one.lastSentAt !== null)
    .sort(([, a], [, b]) => (b.lastSentAt ?? 0) - (a.lastSentAt ?? 0))[0]?.[1]
  const state = (await read($, isDone)) ? 'terminado' : (await read($, paused)) ? 'en pausa' : 'activo'
  const when = last === undefined ? 'nunca' : `hace ${ago((await $.clock.now()) - (last.lastSentAt ?? 0))}`
  const overall: RelevoLink = all.length > 0 && all.every(([, one]) => one.link === 'linked')
    ? 'linked'
    : all.some(([, one]) => one.link === 'waiting')
      ? 'waiting'
      : 'none'
  const held: RelevoHeld[] = await read($, pending)

  return [
    `${current} ⇄ ${all.map(([key, one]) => labelOf(key, one, false)).join(', ') || '?'} · ${state} · ${LINK_WORDS[overall]} · Esta sesión: ${await $.session.id()}`,
    ...(current === 'planner'
      ? all.map(
          ([key, one]) =>
            `  ${key}: ${one.peer} · ${LINK_WORDS[one.link]}${one.spawned ? ' · herdr' : ''}${one.isBusy ? ' · trabajando' : ''}`,
        )
      : []),
    `ronda ${await read($, round)}/${await limitOf($, maxRounds)} · último envío ${when}`,
    last?.lastSent == null ? 'último mensaje: (ninguno)' : `último mensaje:\n${last.lastSent}`,
    ...held.map(one => `retenido para ${one.to}: /relevo resume lo envía.`),
    ...((await read($, inbox)) === null
      ? []
      : [
          (await read($, paused))
            ? 'ronda recibida en pausa: /relevo resume se la pasa al modelo.'
            : 'ronda recibida retenida hasta que respondan todos: /relevo resume se la pasa ya al modelo.',
        ]),
    ...(asked === null ? [] : [asked]),
  ].join('\n')
}

// Whether a delivery was composed by another session's relevo: a peer's,
// named relevo, and not an unverified mailbox entry. The name is the sender
// engine's claim; a model's own SendMessage never carries it, so this keeps
// model-written text out. It is not proof of who sent it: the nonce and the
// person's confirmation are.
function fromRelevo(origin: SessionReceiveOrigin): boolean {
  if (origin.kind !== 'peer' || !('plugin' in origin) || origin.plugin !== 'relevo') {
    return false
  }

  return !('isVerified' in origin) || origin.isVerified
}

const LONG_TOAST = { timeoutMs: 15000 }

// The link messages relevo exchanges itself, never shown to the model. An ask
// is held as an invite for the person to accept; nothing is ever answered to
// an id a message names, so an asker learns nothing from this session. The
// one exception is a worker this planner started: it waits under a session
// id the planner chose, so its ask from that id links, and the ack goes to
// the id the planner stored. An ok links only when it echoes the nonce this
// session sent, from a role that pairs with this one.
async function answerLink($: $, opts: Opts, text: string): Promise<void> {
  const message = parseLink(text)
  if (message === null) {
    $.ui.toast('relevo: descartado un mensaje de enlace mal formado.')

    return
  }
  const current = await read($, role)
  const all: Links = await read($, links)

  if (message.kind === 'ask') {
    if (message.id === (await $.session.id())) {
      return
    }
    const made = current === 'planner' && message.from !== 'planner' ? all[message.from] : undefined
    if (made !== undefined && made.spawned && made.link === 'waiting' && made.peer === message.id) {
      await setLink($, message.from, { nonce: message.nonce, link: 'linked' })
      await sendQuiet($, made.peer, linkOk('planner', message.nonce))
      $.ui.toast(`relevo: ${message.from} enlazado.`)
      await flush($, opts, message.from)

      return
    }
    // A linked worker takes no other planner; a linked planner may take
    // another worker, once the person accepts it.
    if (current !== null && isAnyLinked(all) && (current !== 'planner' || message.from === 'planner')) {
      $.ui.toast(`relevo: ${short(message.id)} pidió enlazar, pero esta sesión ya está enlazada; ignorado.`)

      return
    }
    await update($, invite, () => ({ from: message.from, id: message.id, nonce: message.nonce }))
    $.ui.toast(`relevo: ${(await inviteLine($)) ?? ''}`, LONG_TOAST)

    return
  }
  const found = Object.entries(all).find(([, one]) => one.link === 'waiting' && one.nonce === message.nonce)
  if (current === null || found === undefined || !fits(current, message.from) || found[1].spawned) {
    return
  }
  const key = current === 'planner' ? await renameLink($, found[0], message.from) : found[0]
  await setLink($, key, { link: 'linked' })
  // An ask that crossed this one is settled now: accepting it would re-key.
  await update($, invite, () => null)
  const held = ((await read($, pending)) as RelevoHeld[]).length === 0 ? '' : ' /relevo resume envía lo retenido.'
  $.ui.toast(`relevo: ${labelOf(key, found[1])} aceptó; sesiones enlazadas.${held}`)
}

// A started worker just linked: its held handoff goes out under the round
// the planner's turn already took, unless the relay is paused.
async function flush($: $, opts: Opts, to: string) {
  const item = ((await read($, pending)) as RelevoHeld[]).find(one => one.to === to)
  if (item === undefined || (await read($, paused)) || (await read($, isDone))) {
    return
  }
  const n = item.round ?? Math.max(1, await read($, round))
  const outcome = await sendOne($, opts, 'planner', { to: item.to, body: item.body }, n)
  if (outcome === 'sent') {
    await update($, round, at => Math.max(at, n))
    await update($, turn, () => 'peer')
  }
}

export const register: Register = (on, options) => {
  const opts: Opts = {
    maxRounds: Math.max(1, Number(options.maxRounds ?? 10)),
    maxWorkers: Math.max(1, Number(options.maxWorkers ?? 3)),
  }
  const { maxRounds } = opts
  let ticker: Timer | undefined
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relevo',
      description: 'Conecta esta sesión con otras: una planifica, los workers construyen, investigan o revisan',
      argumentHint: 'planner|builder <peer> · join <nombre> <peer> · goal <texto> · pause · resume · status · off',
    })
    await showStatus($)
    // Keeps "hace 12s" moving while a relay is set up. One timer per load:
    // a later session.start replaces it rather than adding another.
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void read($, role).then(current => {
        if (current !== null) $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  on('command.run', { command: 'relevo' }, async ($, e) => {
    const [verb = ''] = e.args.trim().split(/\s+/)
    const arg = e.args.trim().slice(verb.length).trim()

    if (verb === 'planner' && arg === '') {
      return { text: await soloPlanner($) }
    }
    if (verb === 'planner' || verb === 'builder') {
      // The rest is the peer whole: a name two sessions share is "name [ref]".
      if (arg === '') {
        return { text: `Uso: /relevo ${verb} <peer>` }
      }

      return { text: await setRole($, verb, arg) }
    }
    if (verb === 'join') {
      const [name = ''] = arg.split(/\s+/)
      const to = arg.slice(name.length).trim()
      if (!isWorkerName(name) || to === '') {
        return { text: 'Uso: /relevo join <nombre> <peer>; el nombre en minúsculas, sin "planner".' }
      }

      return { text: await setRole($, name, to) }
    }
    if (verb === '') return { text: await openPane($) }
    if (verb === 'goal') return { text: await startGoal($, maxRounds, arg) }
    if (verb === 'pause') return { text: await pauseRelay($) }
    if (verb === 'resume') return { text: await resumeRelay($, opts) }
    if (verb === 'off') return { text: await turnOff($) }
    if (verb === 'status') return { text: await statusText($, maxRounds) }

    return { text: USAGE }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const current = await read($, role)
    if (current === null) {
      return result
    }
    const workers = Object.keys((await read($, links)) as Links)

    return {
      sections: [
        ...result.sections,
        { id: 'relevo:role', text: promptOf(current, opts.maxWorkers, workers), scope: 'session' },
      ],
    }
  })

  on('session.receive', { origin: { kind: /^peer/ } }, async ($, e, next) => {
    // A cross-session delivery arrives as the model reads it, inside its
    // <cross-session-message> envelope: the checks read the body within.
    const text = unwrap(e.text)
    if (looksLikeLink(text)) {
      if (!fromRelevo(e.origin)) {
        $.ui.toast('relevo: descartado un mensaje de enlace que no viene de relevo.')

        return { consumed: 'relevo: enlace que no viene de relevo' }
      }
      await answerLink($, opts, text)

      return { consumed: 'relevo: mensaje de enlace' }
    }
    const current = await read($, role)
    // Without a role this session follows no relevo prompt: a header is text.
    if (current === null || !looksLikeHeader(text)) {
      return next(e)
    }
    // A round counts only when a linked peer's relevo sent it: relevo-made,
    // that link's nonce, and a role that pairs with this one. Anything else
    // shaped as one is dropped, as the role prompt tells the model to act on
    // such a header.
    const relayed = parseHeader(text)
    const all: Links = await read($, links)
    const found =
      relayed === null || relayed.nonce === null
        ? undefined
        : Object.entries(all).find(([, one]) => one.nonce !== null && one.nonce === relayed.nonce)
    if (relayed === null || !fromRelevo(e.origin) || found === undefined || !fits(current, relayed.from)) {
      $.ui.toast('relevo: descartado un mensaje de ronda no verificado.')

      return { consumed: 'relevo: ronda no verificada' }
    }
    // The nonce proves the peer accepted, even if its ack was lost; a
    // planner's manual link learns the worker's name here then.
    const key = current === 'planner' && !found[1].spawned ? await renameLink($, found[0], relayed.from) : found[0]
    if (current === 'planner' && key !== relayed.from) {
      $.ui.toast('relevo: descartado un mensaje de ronda no verificado.')

      return { consumed: 'relevo: ronda no verificada' }
    }

    // Never lowered: a stale or forged low round cannot reset the count.
    await update($, round, at => Math.max(at, relayed.round))
    const now = await $.clock.now()
    await setLink($, key, { lastReceived: relayed.body, lastReceivedAt: now, link: 'linked', isBusy: false })
    await update($, invite, () => null)
    const plain = `${header(relayed.round, relayed.from)}\n\n${relayed.body}`

    // Paused or done: no model turn until the person resumes.
    if ((await read($, paused)) || (await read($, isDone))) {
      await update($, inbox, held => (held === null ? plain : `${held}\n\n${plain}`))
      $.ui.toast(
        `relevo: llegó la ronda ${relayed.round} de ${labelOf(key, found[1])} en pausa; /relevo resume se la pasa al modelo.`,
      )

      return { consumed: 'relevo: ronda retenida en pausa' }
    }
    // A planner waits for every worker it gave work to: reports that come in
    // first are held, and the last one brings them all in one turn.
    if (current === 'planner') {
      const others = Object.entries((await read($, links)) as Links).filter(
        ([name, one]) => name !== key && (one.isBusy || (one.spawned && one.link === 'waiting')),
      )
      if (others.length > 0) {
        await update($, inbox, held => (held === null ? plain : `${held}\n\n${plain}`))
        $.ui.toast(
          `relevo: informe de ${labelOf(key, found[1])}; esperando a ${others.map(([name, one]) => labelOf(name, one)).join(', ')} para pasarlos juntos (/relevo resume los pasa ya).`,
        )

        return { consumed: 'relevo: informe retenido hasta que respondan todos' }
      }
      const gathered = await read($, inbox)
      if (gathered !== null) {
        await update($, inbox, () => null)
        await update($, turn, () => 'self')

        return next({ ...e, text: `${gathered}\n\n${plain}` })
      }
    }
    await update($, turn, () => 'self')

    // Only ever passed on: the model reads it as a new turn, under the plain
    // header. Nothing is sent from here, so a peer's message never goes back
    // out without a turn.
    return next({ ...e, text: plain })
  }).catch(($, e, next) =>
    // Fails closed: a relevo message whose checks threw never reaches the model.
    looksLikeLink(unwrap(e.text)) || looksLikeHeader(unwrap(e.text)) ? { consumed: 'relevo: error al leer un mensaje' } : next(e),
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return result
    }
    const current = await read($, role)
    const all: Links = await read($, links)
    if (current === null || (current !== 'planner' && Object.keys(all).length === 0) || (await read($, isDone))) {
      return result
    }

    const text = await answerOf($, e.answer)

    if (current === 'planner') {
      const done = extractTag(text, 'done')
      if (done !== null) {
        await update($, isDone, () => true)
        await update($, paused, () => true)
        await update($, turn, () => null)
        $.ui.toast(`relevo: terminado. ${done.split('\n')[0]}`)

        return result
      }
    }

    // A planner's blocks by worker, the last one to each; a worker's last
    // block, whatever it names, to its planner.
    const blocks = extractHandoffs(text)
    const byTarget = new Map<string, string>()
    for (const block of current === 'planner' ? blocks : blocks.slice(-1)) {
      const to = current === 'planner' ? (block.to ?? DEFAULT_WORKER) : 'planner'
      if (current === 'planner' && !isWorkerName(to)) {
        $.ui.toast(`relevo: "${to}" no sirve como nombre de worker; ese <handoff> no sale.`)
        continue
      }
      byTarget.set(to, stripHeader(block.body))
    }
    // Compared without a header of the model's own, as sendOne sends it.
    const items = [...byTarget]
      .filter(([to, body]) => !sameText(body, all[to]?.lastReceived ?? null) && !sameText(body, all[to]?.lastSent ?? null))
      .map(([to, body]) => ({ to, body }))
    if (items.length === 0) {
      return result
    }
    if (await read($, paused)) {
      for (const item of items) await hold($, item)

      return result
    }
    await dispatch($, opts, items)

    return result
  })

  // Drawn only while this session has a role: with relevo always loaded, a
  // session that does not use it keeps its prompt as it was.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const live = await liveStatus($, maxRounds)
    if (live === null) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box width={e.props.bodyColumns} flexDirection="row" gap={1}>
        <Box flexGrow={1}>{liveLine(Text, live, e.props.bodyColumns)}</Box>
        <Button key="open" label="⚙" plain onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const columns = e.props.bodyColumns
    const live = await liveStatus($, maxRounds)
    const self = await $.session.id()
    // $.ui.toast carries no plugin name, unlike a command's output.
    // A toast is one line: the command's second line follows after a dot.
    const toast = (text: string) => $.ui.toast(`relevo: ${text.replace(/\n/g, ' · ')}`)
    const all: Links = await read($, links)
    const connect = async () => {
      const typed = ((await read($, draftPeer)) || Object.values(all)[0]?.peer || '').trim()
      const chosen = await read($, draftRole)
      // No peer as planner: the workers come later, started in herdr.
      if (typed === '' && chosen === 'planner') return toast(await soloPlanner($))
      toast(typed === '' ? 'escribe el peer antes de conectar.' : await setRole($, chosen, typed))
    }
    const begin = async (text: string) => toast(await startGoal($, maxRounds, text.trim()))

    const controls = (
      <Box flexDirection="row" gap={1}>
        {live?.isPaused === true ? (
          <Button
            key="resume"
            label="Reanudar"
            variant="primary"
            onPress={() => void resumeRelay($, opts).then(toast)}
          />
        ) : null}
        {live !== null && !live.isPaused ? (
          <Button key="pause" label="Pausa" onPress={() => void pauseRelay($).then(toast)} />
        ) : null}
        {live !== null ? <Button key="off" label="Quitar" onPress={() => void turnOff($).then(toast)} /> : null}
        <Button key="close" label="Cerrar" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    )

    const objective = await read($, goal)
    const failed = await read($, lastError)
    const asked = await read($, invite)
    const card = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={live === null ? 'claude' : colorOf(live.current)}
        paddingX={1}
      >
        {liveLine(Text, live, columns - 4)}
        {live === null ? (
          <Text dimColor wrap="truncate-end">
            una sesión planifica; sus workers construyen, investigan o revisan, y se pasan el trabajo solos
          </Text>
        ) : null}
        {objective === null ? null : (
          <Text wrap="truncate-end">
            <Text dimColor>objetivo </Text>
            {objective}
          </Text>
        )}
        {live === null
          ? null
          : Object.entries(all)
              .filter(([, one]) => one.link === 'waiting')
              .map(([key, one]) =>
                one.spawned ? (
                  <Text key={`wait-${key}`} color="warning" wrap="truncate-end">
                    arrancando {key} en herdr…
                  </Text>
                ) : (
                  <Text key={`wait-${key}`} color="warning" wrap="wrap">
                    esperando que {short(one.peer)} acepte. Allí: Aceptar en su panel, o /relevo{' '}
                    {acceptVerb(live.current)} {self}
                  </Text>
                ),
              )}
        {failed === null ? null : (
          <Text color="error" wrap="truncate-end">
            ✗ {failed}
          </Text>
        )}
        {asked === null ? null : (
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text color="warning" wrap="wrap">
                ⚑ {asked.id} pide enlazar como {asked.from}; esta sesión sería {acceptVerb(asked.from)}. Acepta solo si
                es tu otra sesión.
              </Text>
            </Box>
            <Button
              key="accept"
              label="Aceptar"
              variant="primary"
              onPress={() => void setRole($, acceptVerb(asked.from), asked.id).then(toast)}
            />
          </Box>
        )}
      </Box>
    )

    // Mobile draws no Select or Input: the status and the buttons alone.
    if (!('Select' in ui) || !('Input' in ui)) {
      return (
        <Box flexDirection="column" width={columns} gap={1}>
          {card}
          {controls}
        </Box>
      )
    }
    const { Select, Input } = ui

    // Before a role: only what connecting needs.
    if (live === null) {
      const typed = await read($, draftPeer)
      const found = await read($, peers)
      // A name two sessions share is offered, and sent to, as "name [ref]".
      const pickOf = (one: RelevoPeer) =>
        one.ref !== undefined && found.filter(two => two.name === one.name).length > 1
          ? `${one.name} [${one.ref}]`
          : one.name
      const picked = found.some(one => pickOf(one) === typed) ? typed ?? undefined : undefined
      const chosen = await read($, draftRole)

      return (
        <Box flexDirection="column" width={columns} gap={1}>
          {card}
          <Box flexDirection="row" gap={1}>
            <Text color={colorOf(chosen)} bold>
              1
            </Text>
            <Select
              key="role"
              label="Rol"
              value={chosen}
              options={[
                { value: 'planner', label: 'planner · divide el objetivo en pasos' },
                { value: 'builder', label: 'builder · ejecuta cada paso' },
              ]}
              onSelect={value => void update($, draftRole, () => (value === 'builder' ? 'builder' : 'planner'))}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color={colorOf(acceptVerb(chosen))} bold>
              2
            </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row" gap={1}>
                {found.length > 0 ? (
                  <Select
                    key="peerPick"
                    label="Sesiones"
                    value={picked}
                    options={found.map(one => ({
                      value: pickOf(one),
                      label: one.status === undefined ? pickOf(one) : `${pickOf(one)} · ${one.status}`,
                    }))}
                    onSelect={value => void update($, draftPeer, () => value)}
                  />
                ) : (
                  <Text dimColor>no se encontraron otras sesiones; escribe el nombre o id</Text>
                )}
                <Button key="refresh" label="↻" plain onPress={() => void loadPeers($)} />
              </Box>
              <Input
                key="peer"
                label="Peer"
                placeholder="nombre o id de la otra sesión"
                value={typed ?? ''}
                submitLabel="conectar"
                onInput={value => void update($, draftPeer, () => value)}
                onSubmit={value => void update($, draftPeer, () => value).then(connect)}
              />
              <Text dimColor wrap="truncate-end">
                esta sesión: {self}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color="success" bold>
              3
            </Text>
            <Button key="connect" label="Conectar" variant="primary" onPress={() => void connect()} />
            <Text dimColor wrap="truncate-end">
              la otra sesión confirma el enlace; planner sin peer, en herdr, crea sus workers
            </Text>
          </Box>
          {controls}
        </Box>
      )
    }

    // With a role: the relay itself, each peer's last handoff each way.
    const held: RelevoHeld[] = await read($, pending)
    const now = await $.clock.now()
    const isWide = columns >= 100
    const half = isWide ? Math.floor((columns - 1) / 2) : columns
    const lines = isWide ? 6 : 4
    const box = (key: string, title: string, color: Color, body: string | null, at: number | null) => (
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        width={half}
      >
        <Text wrap="truncate-end">
          <Text color={color} bold>
            {title}
          </Text>
          {at === null ? null : <Text dimColor> · hace {ago(now - at)}</Text>}
        </Text>
        {body === null ? (
          <Text dimColor>(nada aún)</Text>
        ) : (
          preview(body, lines).map((row, index) => (
            <Text key={`${key}-${index}`} wrap="truncate-end" dimColor={row.startsWith('… ')}>
              {row}
            </Text>
          ))
        )}
      </Box>
    )
    const done = await read($, isDone)

    return (
      <Box flexDirection="column" width={columns} gap={1}>
        {card}
        {live.current === 'planner' && (objective === null || done) ? (
          <Box flexDirection="row" gap={1}>
            <Input
              key="goal"
              label="Objetivo"
              placeholder="qué hay que construir"
              value={await read($, draftGoal)}
              submitLabel="iniciar"
              onInput={value => void update($, draftGoal, () => value)}
              onSubmit={value => void begin(value)}
            />
            <Button key="start" label="Iniciar" variant="primary" onPress={() => void read($, draftGoal).then(begin)} />
          </Box>
        ) : null}
        {Object.entries(all).map(([key, one]) => (
          <Box key={`peer-${key}`} flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 1 : 0}>
            {box(`sent-${key}`, `↑ a ${labelOf(key, one)} · ronda ${live.n}`, colorOf(live.current), one.lastSent, one.lastSentAt)}
            {box(`got-${key}`, `↓ de ${labelOf(key, one)}`, colorOf(key), one.lastReceived, one.lastReceivedAt)}
          </Box>
        ))}
        {held.map(one => (
          <Box key={`held-${one.to}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" bold>
              ⏸ retenido para {one.to} · sale con Reanudar
            </Text>
            {preview(one.body, 3).map((row, index) => (
              <Text key={`held-${one.to}-${index}`} wrap="truncate-end">
                {row}
              </Text>
            ))}
          </Box>
        ))}
        {controls}
      </Box>
    )
  })
}

// The turn's final text carries the tags; when it does not (a tool call came
// last), the newest assistant message from the transcript is read instead.
async function answerOf($: $, answer: string): Promise<string> {
  if (/<(handoff|done)[\s>]/.test(answer)) {
    return answer
  }
  try {
    const rows = await $.session.messages()
    const last = Array.isArray(rows) ? rows.filter(row => row.role === 'assistant').at(-1) : undefined

    return last?.text ?? answer
  } catch {
    return answer
  }
}
