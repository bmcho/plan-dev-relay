import type { AgentTodo } from '../types'

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
