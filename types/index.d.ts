export type Role = 'plan' | 'dev'
// extra: 작업 중에 추가로 받은 지시의 첫 줄
export type Task = { source: 'plan' | 'direct'; title: string; prompt: string; extra?: string[] }
export type CommandRun = { command: string; isOk: boolean }

declare module 'claude-code' {
  interface PluginState {
    'plan-dev-relay': {
      role: Role | null
      dir: string
      frame: number
      task: Task | null
      edits: string[]
      commands: CommandRun[]
      reports: string[]
    }
  }
}
