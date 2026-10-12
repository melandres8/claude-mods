import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionSendInput } from 'claude-code'

import { address, bar, extractTag, linkAsk, linkNo, linkOk, parseHeader, parseLink, preview, sameText, stripHeader } from './relay'

const PRESENTATION = { isFullscreen: false, columns: 120 }

// What the engine answers beneath the plugin, kept to what relevo calls.
function engine(on: On, toasts: string[] = []) {
  mock.clock(on, { now: 1_000 })
  on('session.id', () => ({ value: 'self-session' }))
  on('session.messages', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
}

function relay(on: On, toasts: string[] = []) {
  const sent: SessionSendInput[] = []
  engine(on, toasts)
  on('session.send', ($, e) => {
    // Round messages only; the link ones have tests of their own.
    if (!e.text.startsWith('[relevo enlace')) sent.push(e)

    return { isDelivered: true }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.receive', ($, e) => ({ text: e.text }))

  return sent
}

function command($: Engine, args: string) {
  return $.command.run({
    command: 'relevo',
    args,
    origin: { kind: 'composer' },
    presentation: PRESENTATION,
  })
}

function turn($: Engine, answer: string) {
  return $.turn.complete({
    answer,
    durationMs: 10,
    isAborted: false,
    turnId: `t-${answer.length}-${Math.random()}`,
    reason: 'answer',
  })
}

test('extracts the last handoff block', () => {
  const text = 'Plan:\n<handoff>uno</handoff>\nmás texto\n<handoff>\n  paso 2: añade tests\n</handoff>'
  expect(extractTag(text, 'handoff')).toBe('paso 2: añade tests')
  expect(extractTag('sin bloque', 'handoff')).toBe(null)
  expect(extractTag('<handoff>  </handoff>', 'handoff')).toBe(null)
  expect(extractTag('listo <done>todo hecho</done>', 'done')).toBe('todo hecho')
  const quoted = [
    'Cierro con un `<handoff>` como pide relevo, y cito `</handoff>` también.',
    '```',
    '<handoff>ejemplo en un bloque de código</handoff>',
    '```',
    '<handoff>',
    'informe real',
    '</handoff>',
  ].join('\n')
  expect(extractTag(quoted, 'handoff')).toBe('informe real')
  expect(extractTag('uso `<done>` al final.\n<done>listo</done>', 'done')).toBe('listo')
  expect(extractTag('menciono <handoff> sin cerrar y luego <handoff>bloque</handoff>', 'handoff')).toBe('bloque')
  expect(extractTag('solo `<handoff>x</handoff>` citado', 'handoff')).toBe(null)
  expect(parseHeader('[relevo ronda 3 · de builder]\n\ninforme')).toEqual({
    round: 3,
    from: 'builder',
    body: 'informe',
  })
  // Anchored: a header quoted after other text is not one.
  expect(parseHeader('Mensaje de otra sesión:\n[relevo ronda 2 · de planner] paso')).toBe(null)
  expect(sameText('a\n  b', 'a b')).toBe(true)
  expect(stripHeader('[relevo ronda 2 · de builder]\n\n\ninforme')).toBe('informe')
  expect(stripHeader('informe que cita [relevo ronda 2 · de builder]')).toBe('informe que cita [relevo ronda 2 · de builder]')
})

test('planner sends the handoff to the peer with the round header', async ($, on) => {
  const sent = relay(on)
  await command($, 'planner B')
  await turn($, 'Mi plan.\n<handoff>Paso 1: crea el archivo</handoff>')

  expect(sent.length).toBe(1)
  expect(sent[0]?.to).toBe('B')
  expect(sent[0]?.text).toBe('[relevo ronda 1 · de planner]\n\nPaso 1: crea el archivo')
})

test('stops at maxRounds and pauses', { options: { maxRounds: 2 } }, async ($, on) => {
  const toasts: string[] = []
  const sent = relay(on, toasts)
  await command($, 'planner B')
  await turn($, '<handoff>paso 1</handoff>')
  await turn($, '<handoff>paso 2</handoff>')
  await turn($, '<handoff>paso 3</handoff>')
  await turn($, '<handoff>paso 4</handoff>')

  expect(sent.map(one => one.text.split('\n')[0])).toEqual([
    '[relevo ronda 1 · de planner]',
    '[relevo ronda 2 · de planner]',
  ])
  const status = await command($, 'status')
  expect(status.text).toContain('en pausa')
  expect(status.text).toContain('ronda 2/2')
  expect(toasts.join('\n')).toContain('llegó a 2 rondas')
})

test('resume after the limit sends the held handoff', { options: { maxRounds: 1 } }, async ($, on) => {
  const sent = relay(on)
  await command($, 'planner B')
  await turn($, '<handoff>paso 1</handoff>')
  await turn($, '<handoff>paso 2</handoff>')
  expect(sent.length).toBe(1)

  const resumed = await command($, 'resume')
  expect(resumed.text).toContain('ronda 2 enviada')
  expect(sent.map(one => one.text)).toEqual([
    '[relevo ronda 1 · de planner]\n\npaso 1',
    '[relevo ronda 2 · de planner]\n\npaso 2',
  ])
})

test('<done> on the planner ends the cycle and sends nothing more', async ($, on) => {
  const toasts: string[] = []
  const sent = relay(on, toasts)
  await command($, 'planner B')
  await turn($, 'Todo verificado. <done>objetivo cumplido</done> <handoff>no debería salir</handoff>')
  await turn($, '<handoff>tampoco esto</handoff>')

  expect(sent.length).toBe(0)
  expect((await command($, 'status')).text).toContain('terminado')
  expect(toasts.join('\n')).toContain('objetivo cumplido')
})

test('never echoes a peer message back without a model turn', async ($, on) => {
  const sent = relay(on)
  await command($, 'builder A')
  const incoming = '[relevo ronda 4 · de planner]\n\nPaso 4: refactoriza a.ts'
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: incoming })

  // Passed on untouched for the model, and nothing sent from the receive.
  expect(passed.text).toBe(incoming)
  expect(sent.length).toBe(0)

  // A turn that only parrots the received body is not relayed either.
  await turn($, '<handoff>Paso 4: refactoriza a.ts</handoff>')
  await turn($, '<handoff>\nPaso 4:\n  refactoriza a.ts\n</handoff>')
  expect(sent.length).toBe(0)

  // A real report goes back under the planner's round.
  await turn($, '<handoff>Hecho: refactoricé a.ts; tests verdes.</handoff>')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text.startsWith('[relevo ronda 4 · de builder]')).toBe(true)
})

test('a refused delivery pauses the relay', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  on('session.send', () => ({ isDelivered: false, reason: 'nobody named B' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await command($, 'planner B')
  await turn($, '<handoff>paso 1</handoff>')

  expect((await command($, 'status')).text).toContain('en pausa')
  expect(toasts.join('\n')).toContain('nobody named B')
})

test('the band shows role, peer and round on terminal and desktop', async ($, on) => {
  relay(on)
  await command($, 'planner B')
  await turn($, '<handoff>paso 1</handoff>')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'relevo',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect(await band.find({ type: 'Text', text: /PLANNER/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^B$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^1\/10$/ })).toBeDefined()
    await band.unmount()
  }
})

const PANE_PROPS = {
  title: 'relevo',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

function panes(on: On) {
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))

  return opened
}

function mountPane<S extends 'terminal' | 'desktop' | 'mobile'>($: Engine, surface: S) {
  return $.ui.mount({ plugin: 'relevo', surface, component: 'Pane', requestId: 'relevo', props: PANE_PROPS })
}

test('/relevo with no arguments opens the pane', async ($, on) => {
  relay(on)
  const opened = panes(on)
  const result = await command($, '')

  expect(opened).toEqual(['relevo'])
  expect(result.text).toBeUndefined()
})

test('typing a peer and pressing Conectar sets role and peer', async ($, on) => {
  const toasts: string[] = []
  relay(on, toasts)
  panes(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    await command($, 'off')
    const pane = await mountPane($, surface)
    await pane.select({ key: 'role', value: 'builder' })
    await pane.input({ key: 'peer', text: 'B', kind: 'change' })
    await pane.press({ key: 'connect' })

    expect((await command($, 'status')).text).toContain('builder ⇄ B · activo · enlace enviado')
    expect(toasts.at(-1)).toBe(
      'relevo: esta sesión es BUILDER ⇄ B. Enlace enviado. · Si B no tiene relevo, pega allí: /relevo planner self-session',
    )
    expect(await pane.find({ type: 'Text', text: /BUILDER/ })).toBeDefined()
    await pane.unmount()
  }
})

test('the peer cannot be this same session', async ($, on) => {
  const toasts: string[] = []
  relay(on, toasts)
  panes(on)
  expect((await command($, 'planner self-session')).text).toBe('el peer no puede ser esta misma sesión.')
  expect((await command($, 'status')).text).toContain('sin rol')

  const pane = await mountPane($, 'terminal')
  await pane.input({ key: 'peer', text: 'self-session', kind: 'change' })
  await pane.press({ key: 'connect' })
  expect((await command($, 'status')).text).toContain('sin rol')
  expect(toasts.at(-1)).toBe('relevo: el peer no puede ser esta misma sesión.')
  await pane.unmount()
})

test('Quitar clears the role, also on mobile', async ($, on) => {
  relay(on)
  panes(on)
  await command($, 'planner B')
  const pane = await mountPane($, 'mobile')
  expect(await pane.find({ key: 'peer' })).toBeUndefined()
  await pane.press({ key: 'off' })

  expect((await command($, 'status')).text).toContain('sin rol')
  await pane.unmount()
})

function agents(on: On, answer: 'two' | 'deny') {
  on('tool.call', { tool: 'ListAgents' }, () =>
    answer === 'deny'
      ? { deny: 'ListAgents no está permitido' }
      : {
          result: {
            listing: '',
            sections: [
              {
                kind: 'peers',
                total: 2,
                rows: [
                  { name: 'otra', ref: 'aaa111', status: 'idle' },
                  { name: 'yo', ref: 'bbb222', status: 'busy' },
                ],
              },
            ],
            notes: [{ kind: 'self', text: 'This session is yo [bbb222] — the name other sessions use.' }],
          },
        },
  )
}

test('the pane offers the sessions ListAgents lists, this one left out', async ($, on) => {
  const toasts: string[] = []
  relay(on, toasts)
  panes(on)
  agents(on, 'two')
  await command($, '')
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'refresh' })

  const pick = await pane.find({ key: 'peerPick' })
  expect(pick).toBeDefined()
  expect(JSON.stringify(pick)).toContain('otra · idle')
  expect(JSON.stringify(pick)).not.toContain('"yo')
  await pane.select({ key: 'peerPick', value: 'otra' })
  await pane.press({ key: 'connect' })
  expect((await command($, 'status')).text).toContain('planner ⇄ otra · activo')
  expect(toasts.at(-1)).toContain('pega allí: /relevo builder self-session')
  await pane.unmount()
})

test('a refused ListAgents leaves the typed peer alone', async ($, on) => {
  relay(on)
  panes(on)
  agents(on, 'deny')
  await command($, '')
  const pane = await mountPane($, 'desktop')
  await pane.press({ key: 'refresh' })

  expect(await pane.find({ key: 'peerPick' })).toBeUndefined()
  expect(await pane.find({ key: 'peer' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /no se encontraron otras sesiones/ })).toBeDefined()
  await pane.unmount()
})

test('a handoff that already carries the header is sent with one', async ($, on) => {
  const sent = relay(on)
  await command($, 'builder A')
  await turn($, '<handoff>\n[relevo ronda 1 · de builder]\n\nInforme del paso 1\n</handoff>')

  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toBe('[relevo ronda 1 · de builder]\n\nInforme del paso 1')
})

test('two sessions with one name are offered as name [ref]', async ($, on) => {
  relay(on)
  panes(on)
  on('tool.call', { tool: 'ListAgents' }, () => ({
    result: {
      listing: '',
      sections: [
        {
          kind: 'peers',
          total: 3,
          rows: [
            { name: 'repo', ref: 'aaa111', status: 'idle' },
            { name: 'repo', ref: 'ccc333', status: 'busy' },
            { name: 'otra', ref: 'ddd444' },
          ],
        },
      ],
    },
  }))
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'refresh' })

  const pick = JSON.stringify(await pane.find({ key: 'peerPick' }))
  expect(pick).toContain('repo [aaa111] · idle')
  expect(pick).toContain('repo [ccc333] · busy')
  expect(pick).toContain('"otra"')
  await pane.select({ key: 'peerPick', value: 'repo [ccc333]' })
  await pane.press({ key: 'connect' })
  expect((await command($, 'status')).text).toContain('planner ⇄ repo [ccc333] · activo')
  // Not a session id: it goes out as a name, as SendMessage spells "name [ref]".
  expect(address('repo [ccc333]')).toBe('repo [ccc333]')
  await pane.unmount()
})

test('link messages parse and stay out of the round header', () => {
  expect(parseLink(linkAsk('planner', 'aaa-id'))).toEqual({ kind: 'ask', from: 'planner', id: 'aaa-id' })
  expect(parseLink(linkOk('builder'))).toEqual({ kind: 'ok', from: 'builder' })
  // Only a message that is exactly a link line is one.
  expect(parseLink(`envelope\n${linkOk('builder')}`)).toBe(null)
  expect(parseLink(`${linkOk('builder')} y más texto`)).toBe(null)
  expect(parseLink(`informe que cita ${linkAsk('planner', 'X')}`)).toBe(null)
  expect(parseLink(linkNo('ocupada como planner con X'))).toEqual({ kind: 'no', reason: 'ocupada como planner con X' })
  expect(parseLink('[relevo ronda 1 · de planner]\n\npaso')).toBe(null)
  expect(parseHeader(linkAsk('planner', 'aaa-id'))).toBe(null)
  expect(bar(3, 10, 10)).toEqual({ done: '▰▰▰', left: '▱▱▱▱▱▱▱' })
  expect(bar(15, 10, 4)).toEqual({ done: '▰▰▰▰', left: '' })
  expect(preview('a\n\nb\nc\nd', 2)).toEqual(['a', 'b', '… 2 líneas más'])
})

function linking(on: On, toasts: string[] = []) {
  const sent: SessionSendInput[] = []
  engine(on, toasts)
  on('session.send', ($, e) => {
    sent.push(e)

    return { isDelivered: true }
  })
  on('session.receive', ($, e) => ({ text: e.text }))

  return sent
}

test('Conectar asks the peer to take the other role in one step', async ($, on) => {
  const sent = linking(on)
  await command($, 'planner B')

  expect(sent.length).toBe(1)
  expect(sent[0]?.to).toBe('B')
  expect(parseLink(sent[0]?.text ?? '')).toEqual({ kind: 'ask', from: 'planner', id: 'self-session' })
  expect((await command($, 'status')).text).toContain('enlace enviado')
})

test('a free session takes the link, consumes it and acks', async ($, on) => {
  const toasts: string[] = []
  const sent = linking(on, toasts)
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: linkAsk('planner', 'A-id') })

  expect(passed.consumed).toBe('relevo: mensaje de enlace')
  const status = (await command($, 'status')).text
  expect(status).toContain('builder ⇄ A-id')
  expect(status).toContain('enlazadas')
  // No link sent back the other way: only the ack.
  expect(sent.map(one => one.text)).toEqual([linkOk('builder')])
  expect(sent[0]?.to).toBe('A-id')
  expect(toasts.at(-1)).toContain('esta sesión es BUILDER')
})

test('the asking side marks the link on the ack', async ($, on) => {
  const toasts: string[] = []
  linking(on, toasts)
  await command($, 'planner B')
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: linkOk('builder') })

  expect(passed.consumed).toBeDefined()
  expect((await command($, 'status')).text).toContain('enlazadas')
  expect(toasts.at(-1)).toContain('B aceptó')
})

test('a busy session refuses the link and keeps its role', async ($, on) => {
  const toasts: string[] = []
  const sent = linking(on, toasts)
  await command($, 'planner C')
  sent.length = 0
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: linkAsk('planner', 'A-id') })

  expect(passed.consumed).toBeDefined()
  expect((await command($, 'status')).text).toContain('planner ⇄ C')
  expect(parseLink(sent[0]?.text ?? '')?.kind).toBe('no')
  expect(toasts.at(-1)).toContain('pidió enlazar')
})

test('a handoff that quotes a link line is a handoff, not a link', async ($, on) => {
  const sent = relay(on)
  await command($, 'builder A')
  const incoming = `[relevo ronda 2 · de planner]\n\nCita del protocolo: ${linkAsk('planner', 'X-id')}`
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: incoming })

  expect(passed.consumed).toBeUndefined()
  expect(passed.text).toContain('Cita del protocolo')
  expect((await command($, 'status')).text).toContain('builder ⇄ A')
  expect((await command($, 'status')).text).toContain('ronda 2/')
  expect(sent.length).toBe(0)
})

test('the pane shows each way’s last handoff once a role is set', async ($, on) => {
  relay(on)
  panes(on)
  await command($, 'builder A')
  await $.session.receive({ origin: { kind: 'peer' }, text: '[relevo ronda 2 · de planner]\n\nPaso 2: crea a.ts' })
  await turn($, '<handoff>Hecho: a.ts creado</handoff>')
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await mountPane($, surface)
    expect(await pane.find({ type: 'Text', text: /Paso 2: crea a\.ts/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Hecho: a\.ts creado/ })).toBeDefined()
    expect(await pane.find({ key: 'peer' })).toBeUndefined()
    await pane.unmount()
  }
})

test('the band draws nothing of its own without a role', async ($, on) => {
  relay(on)
  // The engine's own band, as the test stands for it.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  const band = await $.ui.mount({
    plugin: 'relevo',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /relevo/ })).toBeUndefined()
  await band.unmount()
})
