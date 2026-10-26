export type Role = 'plan' | 'dev'
// extra: 작업 중에 추가로 받은 지시의 첫 줄
export type Task = { source: 'plan' | 'direct'; title: string; prompt: string; extra?: string[] }
export type CommandRun = { command: string; isOk: boolean }
// 검수 뒤 진행 방식: 수동(검수만), 오토(반려면 다시 지시), 풀오토(다음 작업과 결정까지).
// rounds: 마지막 사용자 프롬프트 뒤로 사람 없이 이어 가게 넘긴 보고 수
export type Review = { mode: 'manual' | 'auto' | 'full'; max: number; rounds: number }
// 에이전트가 TaskCreate·TaskUpdate·TodoWrite로 적은 단계. id는 TaskCreate가 준 값이고 TodoWrite 항목에는 없다.
export type AgentTodo = { id?: string; text: string; status: 'pending' | 'in_progress' | 'completed' }
// 기획이 보낸 지시의 첫 줄과 그 진행 상태
export type RelayItem = { title: string; status: 'working' | 'reviewing' | 'passed' | 'rejected' }
// <logDir>/todo-<역할>.json의 내용. relay는 기획만, todoFor(개발 Todo가 속한 지시 제목)는 개발만 채운다.
export type TodoShare = { sessionId: string; todos: AgentTodo[]; relay: RelayItem[]; todoFor: string | null }
// 기획이 짝 개발 세션의 봉투에서 배운 주소(from)와 이름(from-name)
export type DevNames = { sessionId: string; names: string[] }

// 메인 loop의 마지막 모델 요청이 쓴 모델과 effort. effort를 받지 않는 모델은 effort가 없다.
export type MainModel = { model: string; effort?: string | number }

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
      // 메인이 띄운 서브에이전트 중 아직 일하는 것의 id. 이 동안은 세션이 일하는 중으로 본다.
      agents: string[]
      // 메인 loop의 마지막 모델 요청. 아직 없으면 null
      mainModel: MainModel | null
      // 이 세션 에이전트의 To-Do. 완료 항목도 남긴다.
      todos: AgentTodo[]
      // 기획: 가장 최근 지시의 행
      relay: RelayItem[]
      // 개발: todos가 속한 지시의 제목
      todoFor: string | null
      // 2초마다 읽은 짝의 공유 파일
      partner: TodoShare | null
      // 기획: 짝 개발 세션의 봉투에서 배운 주소(from)와 이름(from-name)
      devNames: DevNames | null
    }
  }
}
