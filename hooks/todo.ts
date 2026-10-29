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

// 기획이 모두 끝났는지: 단계가 모두 완료되고 릴레이 행이 모두 통과했다. 둘 다 비었으면 끝낼 것이 없다.
export const isAllDone = (todos: AgentTodo[], rows: RelayItem[]) =>
  todos.length + rows.length > 0 &&
  todos.every(todo => todo.status === 'completed') &&
  rows.every(row => row.status === 'passed')

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])
const RELAY_STATUS = new Set(['working', 'reviewing', 'passed', 'rejected'])

const isTodo = (item: unknown) =>
  typeof (item as AgentTodo | null)?.text === 'string' && TODO_STATUS.has((item as AgentTodo).status)

const isTask = (item: unknown) => {
  const task = item as { id?: unknown; subject?: unknown; status?: unknown } | null
  return typeof task?.id === 'string' && typeof task.subject === 'string' && TODO_STATUS.has(String(task.status))
}

// TaskList는 지금 살아 있는 작업 전체를 준다. 목록에 없는 작업(Claude Code가 이미 치운 것)은 지우고,
// 이름과 상태는 그 결과로 맞춘다. id가 없는 TodoWrite 항목은 그대로 둔다. 모양이 다르면 목록을 그대로 둔다.
export const applyTaskList = (todos: AgentTodo[], result: unknown): AgentTodo[] => {
  const tasks = (result as { tasks?: unknown } | null | undefined)?.tasks
  if (!Array.isArray(tasks) || !tasks.every(isTask)) return todos
  const listed = tasks as { id: string; subject: string; status: AgentTodo['status'] }[]
  return [
    ...todos.filter(todo => todo.id === undefined),
    ...listed.map(task => ({ id: task.id, text: task.subject, status: task.status })),
  ]
}

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

// prefix는 들여쓰기와 기호다. band가 따로 그려서 긴 글이 접혀도 기호 열이 유지된다.
export type TodoLine = { prefix: string; text: string; isHeader: boolean; isDone: boolean }

const TODO_MARK: Record<AgentTodo['status'], string> = { completed: '☑', in_progress: '▶', pending: '☐' }
const ROW_MARK: Record<RelayItem['status'], string> = { working: '▶', reviewing: '◇', passed: '☑', rejected: '✗' }
const ROW_LABEL: Record<RelayItem['status'], string> = {
  working: '개발 중',
  reviewing: '검수 중',
  passed: '통과',
  rejected: '반려',
}

// 줄이 모자라면 진행 중 항목(없으면 첫 대기 항목, 그것도 없으면 마지막 항목)의 바로 앞부터 보여 준다.
export const todoWindow = (todos: AgentTodo[], size: number): AgentTodo[] => {
  if (todos.length <= size) return todos
  if (size <= 0) return []
  const working = todos.findIndex(todo => todo.status === 'in_progress')
  const waiting = todos.findIndex(todo => todo.status === 'pending')
  const anchor = working !== -1 ? working : waiting !== -1 ? waiting : todos.length - 1
  const start = Math.min(Math.max(anchor - 1, 0), todos.length - size)
  return todos.slice(start, start + size)
}

const progress = (todos: AgentTodo[]) =>
  `완료 ${todos.filter(todo => todo.status === 'completed').length}/${todos.length}`

const todoLine = (todo: AgentTodo, indent: string): TodoLine => ({
  prefix: `${indent}${TODO_MARK[todo.status]} `,
  text: todo.text,
  isHeader: false,
  isDone: todo.status === 'completed',
})

// status가 null인 행은 기획 몫이 없을 때 개발의 todoFor로 만든 행이다.
type Row = { title: string; status: RelayItem['status'] | null }

const rowLine = (row: Row): TodoLine => ({
  prefix: row.status === null ? ' ' : ` ${ROW_MARK[row.status]} `,
  text: row.status === null ? row.title : `${row.title}  ${ROW_LABEL[row.status]}`,
  isHeader: false,
  isDone: row.status === 'passed',
})

// 두 세션이 같은 목록을 그린다. plan은 기획 몫, dev는 개발 몫이고 limit은 목록에 쓸 수 있는 줄 수다.
export const todoLines = (
  plan: { todos: AgentTodo[]; relay: RelayItem[] } | null,
  dev: { todos: AgentTodo[]; todoFor: string | null } | null,
  limit: number,
): TodoLine[] => {
  const room = Math.max(0, limit)
  const planTodos = plan?.todos ?? []
  const todoFor = dev?.todoFor ?? null
  const ownTodos = dev?.todos ?? []
  // 기획 몫이 없으면(짝 없음) 개발 Todo를 todoFor 제목의 상태 없는 행 아래에 붙인다.
  const rows: Row[] =
    plan !== null ? plan.relay : todoFor !== null && ownTodos.length > 0 ? [{ title: todoFor, status: null }] : []
  // 개발 Todo는 제목이 todoFor와 같은 행 아래에만 붙는다.
  const owner = todoFor === null ? -1 : rows.findIndex(row => row.title === todoFor)
  const devTodos = owner === -1 ? [] : ownTodos

  // 구역 제목 줄도 센다. 기획은 최소 3줄을 받고, 남은 줄을 릴레이가 쓴다.
  const planNeed = planTodos.length === 0 ? 0 : 1 + planTodos.length
  const relayNeed = rows.length === 0 ? 0 : 1 + rows.length + devTodos.length
  const planSize = Math.min(planNeed, Math.max(Math.min(3, room), room - relayNeed))
  const relaySize = Math.min(relayNeed, room - planSize)

  const lines: TodoLine[] = []
  if (planSize > 0) {
    lines.push({ prefix: '', text: `기획 To-Do  ${progress(planTodos)}`, isHeader: true, isDone: false })
    lines.push(...todoWindow(planTodos, planSize - 1).map(todo => todoLine(todo, ' ')))
  }
  if (relaySize > 0) {
    const count = devTodos.length > 0 ? `  ${progress(devTodos)}` : ''
    lines.push({ prefix: '', text: `릴레이 To-Do${count}`, isHeader: true, isDone: false })
    // 행이 먼저 줄을 쓰고, 남은 줄을 개발 Todo가 쓴다.
    const shown = rows.slice(0, relaySize - 1)
    const todoRoom = relaySize - 1 - shown.length
    shown.forEach((row, index) => {
      lines.push(rowLine(row))
      if (index === owner) lines.push(...todoWindow(devTodos, todoRoom).map(todo => todoLine(todo, '    ')))
    })
  }
  return lines
}
