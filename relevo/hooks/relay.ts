import type { RelevoRole } from '../types'

// Anchored: a delivery's text is its body as the model reads it, with no
// envelope before it, so a header is one only at the very start. On the wire
// it carries the link's nonce; the model reads it, and may copy it, without.
const HEADER = /^\s*\[relevo ronda (\d+) · de (planner|builder)(?: · ([\w-]+))?\]\s*/

// The last whole block: the last closing tag, and the last opening before it.
// A tag quoted in code (`<handoff>` in prose, a fenced example) is not one:
// code is blanked out, same length, before the tags are looked for.
export function extractTag(text: string, tag: 'handoff' | 'done'): string | null {
  const blank = (code: string) => ' '.repeat(code.length)
  const masked = text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank)
  const open = `<${tag}>`
  const close = masked.lastIndexOf(`</${tag}>`)
  const start = close === -1 ? -1 : masked.lastIndexOf(open, close)
  if (start === -1) {
    return null
  }
  const body = text.slice(start + open.length, close).trim()

  return body === '' ? null : body
}

export function header(round: number, from: RelevoRole, nonce?: string): string {
  return nonce === undefined ? `[relevo ronda ${round} · de ${from}]` : `[relevo ronda ${round} · de ${from} · ${nonce}]`
}

// Text that starts as a round header does, well formed or not.
export function looksLikeHeader(text: string): boolean {
  return /^\s*\[relevo ronda/.test(text)
}

// The body without a header the model already wrote at its start, nor the
// blank lines after it: deliver puts its own, so the peer reads one.
export function stripHeader(body: string): string {
  const match = HEADER.exec(body)

  return match === null ? body : body.slice(match[0].length).trim()
}

export function parseHeader(
  text: string,
): { round: number; from: RelevoRole; nonce: string | null; body: string } | null {
  const match = HEADER.exec(text)
  if (match === null) {
    return null
  }

  return {
    round: Number(match[1]),
    from: match[2] as RelevoRole,
    nonce: match[3] ?? null,
    body: text.slice(match[0].length).trim(),
  }
}

// Collapses whitespace so a body the model copied back with other line breaks
// still counts as the same text.
export function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return false
  }

  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

// A session id is a uuid or a remote id; anything else is a name as
// ListAgents prints it.
export function address(peer: string): string | { sessionId: string } {
  const isId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(peer) ||
    peer.startsWith('session_')

  return isId ? { sessionId: peer } : peer
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.round(seconds / 60)

  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

// The link. A asks B to take the other role, naming its own session id and a
// nonce of its making; B's person accepts, and B acks echoing the nonce.
// None matches HEADER, so parseHeader never reads one.
export type LinkMessage =
  | { kind: 'ask'; from: RelevoRole; id: string; nonce: string }
  | { kind: 'ok'; from: RelevoRole; nonce: string }

// Anchored at both ends: a message is a link message only when its whole
// text is one link line, so a handoff that quotes one stays a handoff.
const LINK_ASK = /^\s*\[relevo enlace · (planner|builder) (\S+) ([\w-]+)\]\s*$/
const LINK_OK = /^\s*\[relevo enlace-ok · (planner|builder) ([\w-]+)\]\s*$/

export function linkAsk(from: RelevoRole, id: string, nonce: string): string {
  return `[relevo enlace · ${from} ${id} ${nonce}]`
}

export function linkOk(from: RelevoRole, nonce: string): string {
  return `[relevo enlace-ok · ${from} ${nonce}]`
}

export function parseLink(text: string): LinkMessage | null {
  const ask = LINK_ASK.exec(text)
  if (ask !== null) {
    return { kind: 'ask', from: ask[1] as RelevoRole, id: ask[2] ?? '', nonce: ask[3] ?? '' }
  }
  const ok = LINK_OK.exec(text)

  return ok === null ? null : { kind: 'ok', from: ok[1] as RelevoRole, nonce: ok[2] ?? '' }
}

// Text that starts as a link message does, well formed or not: what a
// session must not take from anyone but another session's relevo.
export function looksLikeLink(text: string): boolean {
  return /^\s*\[relevo enlace/.test(text)
}

// Rounds as a row of cells, `width` wide: filled up to n of limit.
export function bar(n: number, limit: number, width: number): { done: string; left: string } {
  const filled = limit <= 0 ? 0 : Math.min(width, Math.round((Math.min(n, limit) / limit) * width))

  return { done: '▰'.repeat(filled), left: '▱'.repeat(width - filled) }
}

// The first lines of a handoff, each cut short, for a preview.
export function preview(text: string, lines: number): string[] {
  const rows = text.split('\n').map(row => row.trimEnd()).filter(row => row.trim() !== '')
  const shown = rows.slice(0, lines)
  if (rows.length > lines) {
    shown.push(`… ${rows.length - lines} líneas más`)
  }

  return shown
}
