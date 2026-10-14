export type Role = 'plan' | 'dev'
// extra: 작업 중에 추가로 받은 지시의 첫 줄
export type Task = { source: 'plan' | 'direct'; title: string; prompt: string; extra?: string[] }
export type CommandRun = { command: string; isOk: boolean }
// 기획 세션의 보고 검토 방식. rounds: 마지막 사용자 프롬프트 뒤로 자동 검토한 횟수
export type Review = { mode: 'manual' | 'auto'; max: number; rounds: number }

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
      review: Review
    }
  }
}
