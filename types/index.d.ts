export type Role = 'plan' | 'dev'
// extra: 작업 중에 추가로 받은 지시의 첫 줄
export type Task = { source: 'plan' | 'direct'; title: string; prompt: string; extra?: string[] }
export type CommandRun = { command: string; isOk: boolean }
// 검수에서 반려됐을 때 다시 지시하는 방식. rounds: 마지막 사용자 프롬프트 뒤로 자동으로 다시 지시할 수 있게 넘긴 보고 수
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
      // 검수 요청이 들어간 turn이 끝나기를 기다리는 중
      reviewing: boolean
      review: Review
    }
  }
}
