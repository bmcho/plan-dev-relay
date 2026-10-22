import type { AgentTodo, RelayItem, TodoShare } from '../types'

// 도구 결과는 엔진이 넘긴 값이라 모양을 확인하고 쓴다. 모양이 다르면 목록을 그대로 둔다.
export const applyTaskCreate = (todos: AgentTodo[], result: unknown): AgentTodo[] => {
  const task = (result as { task?: { id?: unknown; subject?: unknown } } | null | undefined)?.task
  if (typeof task?.id !== 'string' || typeof task.subject !== 'string') return todos
  const id = task.id
  // 같은 id가 다시 오면(에이전트의 목록이 새로 시작된 경우) 옛 항목을 바꾼다.
  return [...todos.filter(todo => todo.id !== id), { id, text: task.subject, status: 'pending' }]
}

export type TaskUpdateInput = {
  taskId: string
  subject?: string
  status?: AgentTodo['status'] | 'deleted'
}

export const applyTaskUpdate = (todos: AgentTodo[], input: TaskUpdateInput, result: unknown): AgentTodo[] => {
  if ((result as { success?: unknown } | null | undefined)?.success !== true) return todos
  const found = todos.find(todo => todo.id === input.taskId)
  if (found === undefined) return todos
  // 완료 항목은 지우지 않는다. ☑로 남긴다.
  if (input.status === 'deleted') {
    return found.status === 'completed' ? todos : todos.filter(todo => todo !== found)
  }
  const status = input.status
  return todos.map(todo =>
    todo === found ? { ...todo, text: input.subject ?? todo.text, status: status ?? todo.status } : todo,
  )
}

export type TodoWriteItem = { content: string; status: AgentTodo['status'] }

// TodoWrite는 목록 전체를 다시 보낸다. 빠진 완료 항목은 앞에 남기고, 빠진 미완료 항목은 지운다.
export const applyTodoWrite = (todos: AgentTodo[], next: readonly TodoWriteItem[]): AgentTodo[] => {
  const texts = new Set(next.map(item => item.content))
  const kept = todos.filter(todo => todo.status === 'completed' && !texts.has(todo.text))
  return [...kept, ...next.map(item => ({ text: item.content, status: item.status }))]
}

// 기획: 일하는 중인 지시가 있으면 덧붙이고, 없으면 목록을 새로 시작한다. 이전 지시는 목록에서 빠진다.
export const relayOnSend = (rows: RelayItem[], title: string): RelayItem[] => {
  const row: RelayItem = { title, status: 'working' }
  return rows.some(item => item.status === 'working') ? [...rows, row] : [row]
}

export const relayOnReport = (rows: RelayItem[]): RelayItem[] =>
  rows.map((row): RelayItem => (row.status === 'working' ? { ...row, status: 'reviewing' } : row))

export const relayOnVerdict = (rows: RelayItem[], verdict: '통과' | '반려'): RelayItem[] => {
  const status = verdict === '통과' ? 'passed' : 'rejected'
  return rows.map((row): RelayItem => (row.status === 'reviewing' ? { ...row, status } : row))
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])
const RELAY_STATUS = new Set(['working', 'reviewing', 'passed', 'rejected'])

const isTodo = (item: unknown) =>
  typeof (item as AgentTodo | null)?.text === 'string' && TODO_STATUS.has((item as AgentTodo).status)

const isRow = (item: unknown) =>
  typeof (item as RelayItem | null)?.title === 'string' && RELAY_STATUS.has((item as RelayItem).status)

// 상대 세션이 쓴 파일이라 모양을 확인한다. 깨졌거나 모양이 다르면 null.
export const parseShare = (text: string): TodoShare | null => {
  try {
    const share = JSON.parse(text) as Partial<TodoShare> | null
    return typeof share?.sessionId === 'string' &&
      Array.isArray(share.todos) &&
      share.todos.every(isTodo) &&
      Array.isArray(share.relay) &&
      share.relay.every(isRow) &&
      (share.todoFor === null || typeof share.todoFor === 'string')
      ? (share as TodoShare)
      : null
  } catch {
    return null
  }
}
