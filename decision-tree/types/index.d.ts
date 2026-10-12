export type DecisionOption = {
  label: string
  /** What is sent as the person's answer when this option is confirmed. */
  reply: string
  /** The asker's own line on the option, when it gave one. */
  detail?: string
}

export type DecisionQuestion = { text: string; header?: string; options: DecisionOption[] }

export type DecisionAsk = {
  id: string
  /** `text`: a question closing a reply; `tool`: an AskUserQuestion call. */
  source: 'text' | 'tool'
  /** The end of the reply (or the call's questions), for the prompts that reason about it. */
  context: string
  questions: DecisionQuestion[]
}

export type DecisionPhase = 'idle' | 'reading' | 'ready' | 'none'

export type DecisionImplication = { status: 'loading' | 'ready' | 'error'; text: string }

export type DecisionFork = {
  status: 'starting' | 'running' | 'done' | 'error'
  agentId?: string
  text: string
  /** The option it tries and the question it answers, to show it once its ask is gone. */
  label?: string
  question?: string
}

declare module 'claude-code' {
  interface PluginState {
    'decision-tree': {
      phase: DecisionPhase
      ask: DecisionAsk | null
      /** The question of the ask shown now. */
      focus: number
      /** The option picked per question, by the question's index. */
      picks: Record<string, number>
      implications: Record<string, DecisionImplication>
      /** Every fork by slot (`<ask id>:<question>:<option>`), kept past its ask. */
      forks: Record<string, DecisionFork>
      forkIds: string[]
    }
  }
}
