// `planner`, or a worker's name (`builder`, `researcher`, ...): the planner
// works with one or more workers, each a session of its own.
export type RelevoRole = string

// Another session ListAgents lists, as the pane's peer picker offers it.
export type RelevoPeer = { name: string; ref?: string; status?: string }

// Who holds the work now: this session's model, the peers', or nobody yet.
export type RelevoTurn = 'self' | 'peer' | null

// The one-step link: none asked, sent and waiting for the ack, or acked.
export type RelevoLink = 'none' | 'waiting' | 'linked'

// A link another session's relevo asked for, held until the person accepts:
// the role the asker takes, its session id and the nonce it chose.
export type RelevoInvite = { from: RelevoRole; id: string; nonce: string }

// One peer of this session, keyed by its role in `links`: a worker's
// `planner`, a planner's one entry per worker name.
export type RelevoPeerLink = {
  // The session id or ListAgents name messages go to.
  peer: string
  // The link's shared secret: the asker makes it, the ack echoes it.
  nonce: string | null
  link: RelevoLink
  // This planner started it in a herdr pane under a session id of its
  // choosing; only its ask, from that id, links without the person.
  spawned: boolean
  // Waiting on this peer's reply to the last round sent.
  isBusy: boolean
  lastSent: string | null
  lastSentAt: number | null
  lastReceived: string | null
  lastReceivedAt: number | null
}

// A handoff held back: the round limit, a pause, no link yet, a failed send.
// `round`: the one a planner's turn took for a worker still starting.
export type RelevoHeld = { to: RelevoRole; body: string; round?: number }

declare module 'claude-code' {
  interface PluginState {
    relevo: {
      hubRole: RelevoRole | null
      links: Record<string, RelevoPeerLink>
      round: number
      paused: boolean
      isDone: boolean
      held: RelevoHeld[]
      cap: number | null
      goal: string | null
      turn: RelevoTurn
      lastError: string | null
      invite: RelevoInvite | null
      // Rounds the peers sent while paused or done, as the model will read
      // them; /relevo resume hands them to the model in one turn.
      inbox: string | null
      // The herdr pane the next worker splits from, and how many it made.
      lastPane: string | null
      spawnCount: number
      draftRole: 'planner' | 'builder'
      draftPeer: string | null
      draftGoal: string
      peers: RelevoPeer[]
    }
  }
}
