export type RelevoRole = 'planner' | 'builder'

// Another session ListAgents lists, as the pane's peer picker offers it.
export type RelevoPeer = { name: string; ref?: string; status?: string }

// Who holds the work now: this session's model, the peer's, or nobody yet.
export type RelevoTurn = 'self' | 'peer' | null

// The one-step link: none asked, sent and waiting for the ack, or acked.
export type RelevoLink = 'none' | 'waiting' | 'linked'

declare module 'claude-code' {
  interface PluginState {
    relevo: {
      role: RelevoRole | null
      peer: string | null
      round: number
      paused: boolean
      isDone: boolean
      lastHandoffAt: number | null
      lastReceivedAt: number | null
      lastReceived: string | null
      lastSent: string | null
      pending: string | null
      cap: number | null
      goal: string | null
      turn: RelevoTurn
      link: RelevoLink
      lastError: string | null
      draftRole: RelevoRole
      draftPeer: string | null
      draftGoal: string
      peers: RelevoPeer[]
    }
  }
}
