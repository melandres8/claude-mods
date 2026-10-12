import { atom, read, update } from 'claude-code'
import type {
  Color,
  ElementConstructor,
  EngineInterface,
  Register,
  SessionReceiveOrigin,
  TextProps,
} from 'claude-code'

import type { RelevoLink, RelevoPeer, RelevoRole, RelevoTurn } from '../types'
import {
  address,
  ago,
  bar,
  extractTag,
  header,
  linkAsk,
  linkOk,
  looksLikeHeader,
  looksLikeLink,
  parseHeader,
  parseLink,
  preview,
  sameText,
  stripHeader,
} from './relay'

const role = atom({ plugin: 'relevo', key: 'role' } as const, null)
const peer = atom({ plugin: 'relevo', key: 'peer' } as const, null)
const round = atom({ plugin: 'relevo', key: 'round' } as const, 0)
const paused = atom({ plugin: 'relevo', key: 'paused' } as const, false)
const isDone = atom({ plugin: 'relevo', key: 'isDone' } as const, false)
const lastHandoffAt = atom({ plugin: 'relevo', key: 'lastHandoffAt' } as const, null)
const lastReceivedAt = atom({ plugin: 'relevo', key: 'lastReceivedAt' } as const, null)
const lastReceived = atom({ plugin: 'relevo', key: 'lastReceived' } as const, null)
const lastSent = atom({ plugin: 'relevo', key: 'lastSent' } as const, null)
const pending = atom({ plugin: 'relevo', key: 'pending' } as const, null)
const cap = atom({ plugin: 'relevo', key: 'cap' } as const, null)
const goal = atom({ plugin: 'relevo', key: 'goal' } as const, null)
const turn = atom({ plugin: 'relevo', key: 'turn' } as const, null)
const link = atom({ plugin: 'relevo', key: 'link' } as const, 'none')
const lastError = atom({ plugin: 'relevo', key: 'lastError' } as const, null)
const nonce = atom({ plugin: 'relevo', key: 'nonce' } as const, null)
const invite = atom({ plugin: 'relevo', key: 'invite' } as const, null)
// What the pane's fields hold until the person presses a button.
const draftRole = atom({ plugin: 'relevo', key: 'draftRole' } as const, 'planner')
const draftPeer = atom({ plugin: 'relevo', key: 'draftPeer' } as const, null)
const draftGoal = atom({ plugin: 'relevo', key: 'draftGoal' } as const, '')
const peers = atom({ plugin: 'relevo', key: 'peers' } as const, [])

const PANE = 'relevo'

// Theme keys, so the colors follow the person's theme.
const ROLE_COLOR: Record<RelevoRole, Color> = { planner: 'planMode', builder: 'autoAccept' }

const PROMPTS: Record<RelevoRole, string> = {
  planner: [
    '# relevo: planner',
    'Divides el objetivo en pasos pequeños y verificables. NO editas código.',
    'Cuando el plan o el siguiente paso esté listo, termina tu respuesta con un bloque <handoff>…</handoff> para el constructor.',
    'Cuando el objetivo esté cumplido, emite <done>resumen</done>.',
    'Los mensajes que empiezan con "[relevo ronda N · de builder]" son el informe del constructor: revísalo y decide el siguiente paso.',
  ].join('\n'),
  builder: [
    '# relevo: builder',
    'Ejecutas exactamente el paso recibido.',
    'Al terminar, cierra con un <handoff> que traiga qué hiciste, qué archivos tocaste, el resultado de los tests y tus dudas.',
    'Los mensajes que empiezan con "[relevo ronda N · de planner]" son el paso que te manda el planificador.',
  ].join('\n'),
}

const USAGE = [
  '/relevo                  abre el panel',
  '/relevo planner <peer>   esta sesión planifica; <peer> es la otra sesión',
  '/relevo builder <peer>   esta sesión construye',
  '/relevo goal <texto>     (planner) arranca el ciclo',
  '/relevo pause | resume   corta o reanuda el envío automático',
  '/relevo status           rol, peer, ronda y último envío',
  '/relevo off              quita el rol',
].join('\n')

type $ = EngineInterface

const other = (verb: RelevoRole): RelevoRole => (verb === 'planner' ? 'builder' : 'planner')

// A session id is long; the drawing shows its first part. Names stay whole.
function short(name: string | null): string {
  if (name === null) return '?'
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)) return name.slice(0, 8)

  return name.startsWith('session_') ? name.slice(0, 16) : name
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

// Sends one handoff the model wrote. A handoff held back by the round limit
// or a failed delivery is kept as pending, and /relevo resume sends it.
async function deliver($: $, maxRounds: number, written: string): Promise<string> {
  const body = stripHeader(written)
  const current = await read($, role)
  const to = await read($, peer)
  const secret = await read($, nonce)
  if (current === null || to === null || secret === null) {
    return 'sin rol'
  }
  const limit = await limitOf($, maxRounds)
  const n = current === 'planner' ? (await read($, round)) + 1 : Math.max(1, await read($, round))
  if (current === 'planner' && n > limit) {
    await update($, pending, () => body)
    await pause($, `llegó a ${limit} rondas; en pausa (/relevo resume para seguir).`)

    return 'límite de rondas'
  }

  let reason: string | null = null
  try {
    const sent = await $.session.send({ to: address(to), text: `${header(n, current, secret)}\n\n${body}` })
    if (!sent.isDelivered) reason = sent.reason
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  if (reason !== null) {
    await update($, pending, () => body)
    await update($, lastError, () => `no se pudo entregar: ${reason}`)
    await pause($, `no se pudo entregar a ${to}: ${reason}. En pausa.`)

    return reason
  }

  await update($, round, () => n)
  await update($, lastSent, () => body)
  await update($, pending, () => null)
  await update($, lastError, () => null)
  await update($, turn, () => 'peer')
  const now = await $.clock.now()
  await update($, lastHandoffAt, () => now)

  return `ronda ${n} enviada`
}

async function reset($: $) {
  await update($, round, () => 0)
  await update($, cap, () => null)
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, lastSent, () => null)
  await update($, pending, () => null)
  await update($, lastHandoffAt, () => null)
  await update($, lastError, () => null)
  await update($, turn, () => null)
}

type Tone = Color
type Live = {
  current: RelevoRole
  to: string | null
  n: number
  limit: number
  isPaused: boolean
  link: RelevoLink
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
  const to = await read($, peer)
  const at = await read($, lastHandoffAt)
  const isPaused = await read($, paused)
  const linked = await read($, link)
  const holder = await read($, turn)
  const failed = await read($, lastError)
  const [state, tone]: [string, Tone] = (await read($, isDone))
    ? ['terminado', 'merged']
    : failed !== null && isPaused
      ? ['en pausa · error', 'error']
      : isPaused
        ? ['en pausa', 'warning']
        : linked === 'waiting'
          ? ['esperando enlace', 'suggestion']
          : holder === 'self'
            ? ['trabajando aquí', 'claude']
            : holder === 'peer' && at !== null
              ? [`turno de ${short(to)} · hace ${ago((await $.clock.now()) - at)}`, 'success']
              : current === 'planner'
                ? ['esperando objetivo', 'suggestion']
                : ['esperando paso', 'suggestion']

  return {
    current,
    to,
    n: await read($, round),
    limit: await limitOf($, maxRounds),
    isPaused,
    link: linked,
    turn: holder,
    state,
    tone,
  }
}

// One row: a dot in the state's color, the role as a chip, the peer, the
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
  const color = ROLE_COLOR[live.current]
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
      <Text bold>{short(live.to)}</Text>
      {live.link === 'linked' ? <Text color="success"> ✓</Text> : null}
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

// One function per /relevo verb, each returning the text the command shows.
// The command parses its arguments and calls these; a pane can call them too.

// Sets the role: the person's own act, the only one that binds a peer or
// sets the link's nonce. When the peer already asked for this pairing, it
// accepts that ask and acks with its nonce; otherwise it asks the peer with
// a fresh nonce, and the peer's person accepts there.
async function setRole($: $, verb: RelevoRole, to: string): Promise<string> {
  const self = await $.session.id()
  const target = to.trim()
  if (target === self) {
    return 'el peer no puede ser esta misma sesión.'
  }
  const asked = await read($, invite)
  const accepting = asked !== null && asked.id === target && other(asked.from) === verb ? asked : null
  await update($, role, () => verb)
  await update($, peer, () => target)
  await reset($)
  await update($, goal, () => null)
  await update($, lastReceived, () => null)
  await update($, lastReceivedAt, () => null)
  await update($, invite, () => null)
  await showStatus($)

  if (accepting !== null) {
    await update($, nonce, () => accepting.nonce)
    await update($, link, () => 'linked')
    await sendQuiet($, target, linkOk(verb, accepting.nonce))

    return `enlazada con ${target}; esta sesión es ${verb.toUpperCase()}.`
  }

  const fresh = crypto.randomUUID()
  await update($, nonce, () => fresh)
  const manual = `/relevo ${other(verb)} ${self}`
  const sent = await sendQuiet($, target, linkAsk(verb, self, fresh))
  await update($, link, () => (sent ? 'waiting' : 'none'))

  return sent
    ? `esta sesión es ${verb.toUpperCase()} ⇄ ${target}. Enlace enviado; acéptalo en ${target} con: ${manual}`
    : `esta sesión es ${verb.toUpperCase()} ⇄ ${target}. No se pudo enviar el enlace.\nEn la otra sesión: ${manual}`
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
  // Not awaited: it resolves when the turn starts, after this command ends.
  void $.prompt.submit({ text: `Objetivo de relevo:\n\n${text}` })

  return `objetivo recibido, planificando (máximo ${maxRounds} rondas).`
}

async function pauseRelay($: $): Promise<string> {
  if ((await read($, role)) === null) {
    return 'no hay rol activo.'
  }
  await update($, paused, () => true)

  return 'en pausa.'
}

async function resumeRelay($: $, maxRounds: number): Promise<string> {
  if ((await read($, role)) === null) {
    return 'no hay rol activo.'
  }
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, lastError, () => null)
  // A resume past the limit grants another maxRounds from here.
  const at = await read($, round)
  if (at >= (await limitOf($, maxRounds))) {
    await update($, cap, () => at + maxRounds)
  }
  const held = await read($, pending)
  const outcome = held === null ? '' : ` Pendiente: ${await deliver($, maxRounds, held)}.`

  return `reanudado (límite ${await limitOf($, maxRounds)} rondas).${outcome}`
}

async function turnOff($: $): Promise<string> {
  await update($, role, () => null)
  await update($, peer, () => null)
  await update($, paused, () => false)
  await update($, isDone, () => false)
  await update($, goal, () => null)
  await update($, turn, () => null)
  await update($, link, () => 'none')
  await update($, lastError, () => null)
  await update($, nonce, () => null)
  await update($, invite, () => null)
  $.ui.status(undefined)

  return 'rol quitado; no se envía nada más.'
}

// The pending link ask as one line, with the command that accepts it.
async function inviteLine($: $): Promise<string | null> {
  const asked = await read($, invite)

  return asked === null
    ? null
    : `${asked.id} pide enlazar como ${asked.from}. Si es tu otra sesión, acepta con: /relevo ${other(asked.from)} ${asked.id}`
}

async function statusText($: $, maxRounds: number): Promise<string> {
  const current = await read($, role)
  const asked = await inviteLine($)
  if (current === null) {
    return [`sin rol. Esta sesión: ${await $.session.id()}`, ...(asked === null ? [] : [asked]), '', USAGE].join('\n')
  }
  const at = await read($, lastHandoffAt)
  const sent = await read($, lastSent)
  const state = (await read($, isDone)) ? 'terminado' : (await read($, paused)) ? 'en pausa' : 'activo'
  const when = at === null ? 'nunca' : `hace ${ago((await $.clock.now()) - at)}`
  const linked = { none: 'sin enlace', waiting: 'enlace enviado, sin respuesta', linked: 'enlazadas' }[
    await read($, link)
  ]

  return [
    `${current} ⇄ ${await read($, peer)} · ${state} · ${linked}`,
    `ronda ${await read($, round)}/${await limitOf($, maxRounds)} · último envío ${when}`,
    sent === null ? 'último mensaje: (ninguno)' : `último mensaje:\n${sent}`,
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
// an id a message names, so an asker learns nothing from this session. An ok
// links only when it echoes the nonce this session sent, from the other role.
async function answerLink($: $, text: string): Promise<void> {
  const message = parseLink(text)
  if (message === null) {
    $.ui.toast('relevo: descartado un mensaje de enlace mal formado.')

    return
  }
  const current = await read($, role)

  if (message.kind === 'ask') {
    if (message.id === (await $.session.id())) {
      return
    }
    if (current !== null && (await read($, link)) === 'linked') {
      $.ui.toast(`relevo: ${short(message.id)} pidió enlazar, pero esta sesión ya está enlazada; ignorado.`)

      return
    }
    await update($, invite, () => ({ from: message.from, id: message.id, nonce: message.nonce }))
    $.ui.toast(`relevo: ${(await inviteLine($)) ?? ''}`, LONG_TOAST)

    return
  }
  const expected = await read($, nonce)
  if (
    current === null ||
    message.from !== other(current) ||
    expected === null ||
    message.nonce !== expected ||
    (await read($, link)) !== 'waiting'
  ) {
    return
  }
  await update($, link, () => 'linked')
  $.ui.toast(`relevo: ${short(await read($, peer))} aceptó; sesiones enlazadas.`)
}

export const register: Register = (on, options) => {
  const maxRounds = Math.max(1, Number(options.maxRounds ?? 10))
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relevo',
      description: 'Conecta esta sesión con otra: una planifica, la otra construye',
      argumentHint: 'planner|builder <peer> · goal <texto> · pause · resume · status · off',
    })
    await showStatus($)
    // Keeps "hace 12s" moving while a relay is set up.
    $.clock.every(1000, () => {
      void read($, role).then(current => {
        if (current !== null) $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  on('command.run', { command: 'relevo' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = e.args.trim().slice(verb.length).trim()

    if (verb === 'planner' || verb === 'builder') {
      if (arg === '' || rest.length !== 1) {
        return { text: `Uso: /relevo ${verb} <peer>` }
      }

      return { text: await setRole($, verb, arg) }
    }
    if (verb === '') return { text: await openPane($) }
    if (verb === 'goal') return { text: await startGoal($, maxRounds, arg) }
    if (verb === 'pause') return { text: await pauseRelay($) }
    if (verb === 'resume') return { text: await resumeRelay($, maxRounds) }
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

    return {
      sections: [...result.sections, { id: 'relevo:role', text: PROMPTS[current], scope: 'session' }],
    }
  })

  on('session.receive', { origin: { kind: /^peer/ } }, async ($, e, next) => {
    if (looksLikeLink(e.text)) {
      if (!fromRelevo(e.origin)) {
        $.ui.toast('relevo: descartado un mensaje de enlace que no viene de relevo.')

        return { consumed: 'relevo: enlace que no viene de relevo' }
      }
      await answerLink($, e.text)

      return { consumed: 'relevo: mensaje de enlace' }
    }
    const current = await read($, role)
    // Without a role this session follows no relevo prompt: a header is text.
    if (current === null || !looksLikeHeader(e.text)) {
      return next(e)
    }
    // A round counts only when the linked peer's relevo sent it: relevo-made,
    // the link's nonce, and the other role. Anything else shaped as one is
    // dropped, as the role prompt tells the model to act on such a header.
    const relayed = parseHeader(e.text)
    const expected = await read($, nonce)
    if (
      relayed === null ||
      !fromRelevo(e.origin) ||
      expected === null ||
      relayed.nonce !== expected ||
      relayed.from !== other(current)
    ) {
      $.ui.toast('relevo: descartado un mensaje de ronda no verificado.')

      return { consumed: 'relevo: ronda no verificada' }
    }

    // Never lowered: a stale or forged low round cannot reset the count.
    await update($, round, at => Math.max(at, relayed.round))
    await update($, lastReceived, () => relayed.body)
    await update($, turn, () => 'self')
    // The nonce proves the peer accepted, even if its ack was lost.
    await update($, link, () => 'linked')
    const now = await $.clock.now()
    await update($, lastReceivedAt, () => now)

    // Only ever passed on: the model reads it as a new turn, under the plain
    // header. Nothing is sent from here, so a peer's message never goes back
    // out without a turn.
    return next({ ...e, text: `${header(relayed.round, relayed.from)}\n\n${relayed.body}` })
  }).catch(($, e, next) =>
    // Fails closed: a relevo message whose checks threw never reaches the model.
    looksLikeLink(e.text) || looksLikeHeader(e.text) ? { consumed: 'relevo: error al leer un mensaje' } : next(e),
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return result
    }
    const current = await read($, role)
    const to = await read($, peer)
    if (current === null || to === null || (await read($, isDone))) {
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

    const tagged = extractTag(text, 'handoff')
    if (tagged === null) {
      return result
    }
    // Compared without a header of the model's own, as deliver sends it.
    const body = stripHeader(tagged)
    if (sameText(body, await read($, lastReceived)) || sameText(body, await read($, lastSent))) {
      return result
    }
    if (await read($, paused)) {
      await update($, pending, () => body)

      return result
    }
    await deliver($, maxRounds, body)

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
    const connect = async () => {
      const to = ((await read($, draftPeer)) || (await read($, peer)) || '').trim()
      toast(to === '' ? 'escribe el peer antes de conectar.' : await setRole($, await read($, draftRole), to))
    }
    const begin = async (text: string) => toast(await startGoal($, maxRounds, text.trim()))

    const controls = (
      <Box flexDirection="row" gap={1}>
        {live?.isPaused === true ? (
          <Button
            key="resume"
            label="Reanudar"
            variant="primary"
            onPress={() => void resumeRelay($, maxRounds).then(toast)}
          />
        ) : null}
        {live !== null && !live.isPaused ? (
          <Button key="pause" label="Pausa" onPress={() => void pauseRelay($).then(toast)} />
        ) : null}
        {live !== null ? <Button key="off" label="Quitar" onPress={() => void turnOff($).then(toast)} /> : null}
        <Button key="close" label="Cerrar" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    )

    const card = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={live === null ? 'claude' : ROLE_COLOR[live.current]}
        paddingX={1}
      >
        {liveLine(Text, live, columns - 4)}
        {live === null ? (
          <Text dimColor wrap="truncate-end">
            una sesión planifica, la otra construye, y se pasan el trabajo solas
          </Text>
        ) : null}
        {await (async () => {
          const objective = await read($, goal)

          return objective === null ? null : (
            <Text wrap="truncate-end">
              <Text dimColor>objetivo </Text>
              {objective}
            </Text>
          )
        })()}
        {live?.link === 'waiting' ? (
          <Text color="warning" wrap="wrap">
            esperando que {short(live.to)} acepte. Allí: Aceptar en su panel, o /relevo {other(live.current)} {self}
          </Text>
        ) : null}
        {await (async () => {
          const failed = await read($, lastError)

          return failed === null ? null : (
            <Text color="error" wrap="truncate-end">
              ✗ {failed}
            </Text>
          )
        })()}
        {await (async () => {
          const asked = await read($, invite)

          return asked === null ? null : (
            <Box flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Text color="warning" wrap="wrap">
                  ⚑ {asked.id} pide enlazar como {asked.from}; esta sesión sería {other(asked.from)}. Acepta solo si
                  es tu otra sesión.
                </Text>
              </Box>
              <Button
                key="accept"
                label="Aceptar"
                variant="primary"
                onPress={() => void setRole($, other(asked.from), asked.id).then(toast)}
              />
            </Box>
          )
        })()}
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
            <Text color={ROLE_COLOR[chosen]} bold>
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
            <Text color={ROLE_COLOR[other(chosen)]} bold>
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
              la otra sesión confirma el enlace
            </Text>
          </Box>
          {controls}
        </Box>
      )
    }

    // With a role: the relay itself, the last handoff each way.
    const sent = await read($, lastSent)
    const got = await read($, lastReceived)
    const held = await read($, pending)
    const sentAt = await read($, lastHandoffAt)
    const gotAt = await read($, lastReceivedAt)
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
    const objective = await read($, goal)
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
        <Box flexDirection={isWide ? 'row' : 'column'} gap={isWide ? 1 : 0}>
          {box('sent', `↑ enviado · ronda ${live.n}`, ROLE_COLOR[live.current], sent, sentAt)}
          {box('got', `↓ recibido de ${short(live.to)}`, ROLE_COLOR[other(live.current)], got, gotAt)}
        </Box>
        {held === null ? null : (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" bold>
              ⏸ retenido · sale con Reanudar
            </Text>
            {preview(held, 3).map((row, index) => (
              <Text key={`held-${index}`} wrap="truncate-end">
                {row}
              </Text>
            ))}
          </Box>
        )}
        {controls}
      </Box>
    )
  })
}

// The turn's final text carries the tags; when it does not (a tool call came
// last), the newest assistant message from the transcript is read instead.
async function answerOf($: $, answer: string): Promise<string> {
  if (/<(handoff|done)>/.test(answer)) {
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
