import { expect, test } from 'claude-code/testing'

import type { AgentTodo, RelayItem } from '../types'
import {
  applyTaskList,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  isAllDone,
  parseShare,
  relayOnReport,
  relayOnSend,
  relayOnVerdict,
  todoLines,
  todoWindow,
  type TodoLine,
} from './todo'

const todo = (id: string, text: string, status: AgentTodo['status'] = 'pending'): AgentTodo => ({
  id,
  text,
  status,
})

test('applyTaskCreate appends a pending item and replaces an item with the same id', () => {
  expect(applyTaskCreate([], { task: { id: '1', subject: '설계' } })).toEqual([todo('1', '설계')])
  const list = [todo('1', '옛 항목', 'completed'), todo('2', '구현')]
  expect(applyTaskCreate(list, { task: { id: '1', subject: '새 항목' } })).toEqual([
    todo('2', '구현'),
    todo('1', '새 항목'),
  ])
})

test('applyTaskCreate leaves the list alone for a result of another shape', () => {
  const list = [todo('1', '설계')]
  expect(applyTaskCreate(list, {})).toBe(list)
  expect(applyTaskCreate(list, null)).toBe(list)
  expect(applyTaskCreate(list, { task: { id: 1, subject: '설계' } })).toBe(list)
})

test('applyTaskUpdate changes a known task only after a successful call', () => {
  const list = [todo('1', '설계'), todo('2', '구현')]
  expect(applyTaskUpdate(list, { taskId: '1', status: 'in_progress' }, { success: true })).toEqual([
    todo('1', '설계', 'in_progress'),
    todo('2', '구현'),
  ])
  expect(applyTaskUpdate(list, { taskId: '2', subject: '구현과 테스트' }, { success: true })).toEqual([
    todo('1', '설계'),
    todo('2', '구현과 테스트'),
  ])
  expect(applyTaskUpdate(list, { taskId: '9', status: 'completed' }, { success: true })).toBe(list)
  expect(applyTaskUpdate(list, { taskId: '1', status: 'completed' }, { success: false })).toBe(list)
  expect(applyTaskUpdate(list, { taskId: '1', status: 'completed' }, undefined)).toBe(list)
})

test('applyTaskUpdate deletes only unfinished tasks and keeps finished ones checked', () => {
  const list = [todo('1', '설계', 'completed'), todo('2', '구현')]
  expect(applyTaskUpdate(list, { taskId: '2', status: 'deleted' }, { success: true })).toEqual([
    todo('1', '설계', 'completed'),
  ])
  expect(applyTaskUpdate(list, { taskId: '1', status: 'deleted' }, { success: true })).toBe(list)
})

test('applyTodoWrite keeps finished items the new list dropped and drops unfinished ones', () => {
  const list: AgentTodo[] = [
    { text: '설계', status: 'completed' },
    { text: '조사', status: 'pending' },
  ]
  expect(applyTodoWrite(list, [{ content: '구현', status: 'in_progress' }])).toEqual([
    { text: '설계', status: 'completed' },
    { text: '구현', status: 'in_progress' },
  ])
  // 새 목록에 같은 글이 있으면 새 목록의 항목만 남는다.
  expect(applyTodoWrite(list, [{ content: '설계', status: 'completed' }])).toEqual([
    { text: '설계', status: 'completed' },
  ])
})

test('relay rows start over unless an instruction is still being worked on', () => {
  const first = relayOnSend([], '1차')
  expect(first).toEqual([{ title: '1차', status: 'working' }])
  expect(relayOnSend(first, '추가')).toEqual([
    { title: '1차', status: 'working' },
    { title: '추가', status: 'working' },
  ])
  const reviewing = relayOnReport(first)
  expect(reviewing).toEqual([{ title: '1차', status: 'reviewing' }])
  // 검수 중에 보낸 다음 지시는 목록을 새로 시작한다.
  expect(relayOnSend(reviewing, '2차')).toEqual([{ title: '2차', status: 'working' }])
})

test('relay rows in review become passed or rejected on a verdict', () => {
  const rows: RelayItem[] = [
    { title: '1차', status: 'reviewing' },
    { title: '추가', status: 'reviewing' },
  ]
  expect(relayOnVerdict(rows, '통과').map(row => row.status)).toEqual(['passed', 'passed'])
  expect(relayOnVerdict(rows, '반려').map(row => row.status)).toEqual(['rejected', 'rejected'])
  const working: RelayItem[] = [{ title: '2차', status: 'working' }]
  expect(relayOnVerdict(working, '통과')).toEqual(working)
})

test('parseShare reads a share and rejects broken or odd ones', () => {
  const share = {
    sessionId: 'S-DEV',
    todos: [{ id: '1', text: '설계', status: 'completed' }],
    relay: [{ title: '1차', status: 'working' }],
    todoFor: '1차',
  }
  expect(parseShare(JSON.stringify(share))).toEqual(share)
  expect(parseShare('{broken')).toBeNull()
  expect(parseShare('null')).toBeNull()
  expect(parseShare(JSON.stringify({ ...share, sessionId: 1 }))).toBeNull()
  expect(parseShare(JSON.stringify({ ...share, todos: [{ text: '설계', status: 'done' }] }))).toBeNull()
  expect(parseShare(JSON.stringify({ ...share, relay: [{ title: 1, status: 'working' }] }))).toBeNull()
  expect(parseShare(JSON.stringify({ ...share, todoFor: 3 }))).toBeNull()
})

const lineTexts = (lines: TodoLine[]) => lines.map(line => line.prefix + line.text)

test('todoWindow starts one item before the one in progress and pulls back at the end', () => {
  const list = [
    todo('1', 'a', 'completed'),
    todo('2', 'b', 'completed'),
    todo('3', 'c', 'in_progress'),
    todo('4', 'd'),
    todo('5', 'e'),
  ]
  expect(todoWindow(list, 2).map(item => item.text)).toEqual(['b', 'c'])
  expect(todoWindow(list, 9)).toBe(list)
  expect(todoWindow(list, 0)).toEqual([])
  const waiting = [todo('1', 'a', 'completed'), todo('2', 'b', 'completed'), todo('3', 'c'), todo('4', 'd')]
  expect(todoWindow(waiting, 2).map(item => item.text)).toEqual(['b', 'c'])
  const finished = [todo('1', 'a', 'completed'), todo('2', 'b', 'completed'), todo('3', 'c', 'completed')]
  expect(todoWindow(finished, 2).map(item => item.text)).toEqual(['b', 'c'])
})

test('todoLines draws both sections and nests the dev Todos under their instruction', () => {
  const relay: RelayItem[] = [{ title: '회원가입 API', status: 'working' }]
  const plan = {
    todos: [todo('1', '요구 정리', 'completed'), todo('2', '계획 작성', 'in_progress'), todo('3', '지시 준비')],
    relay,
  }
  const dev = {
    todos: [todo('1', '예외 클래스', 'completed'), todo('2', '단위 테스트', 'in_progress'), todo('3', 'README')],
    todoFor: '회원가입 API',
  }
  expect(lineTexts(todoLines(plan, dev, 8))).toEqual([
    '기획 To-Do  완료 1/3',
    ' ☑ 요구 정리',
    ' ▶ 계획 작성',
    '릴레이 To-Do  완료 1/3',
    ' ▶ 회원가입 API  개발 중',
    '    ☑ 예외 클래스',
    '    ▶ 단위 테스트',
    '    ☐ README',
  ])
})

test('todoLines splits the mark from the text and flags headers and finished lines', () => {
  const relay: RelayItem[] = [{ title: '1차', status: 'passed' }]
  expect(todoLines({ todos: [todo('1', '설계', 'completed')], relay }, null, 8)).toEqual([
    { prefix: '', text: '기획 To-Do  완료 1/1', isHeader: true, isDone: false },
    { prefix: ' ☑ ', text: '설계', isHeader: false, isDone: true },
    { prefix: '', text: '릴레이 To-Do', isHeader: true, isDone: false },
    { prefix: ' ☑ ', text: '1차  통과', isHeader: false, isDone: true },
  ])
})

test('todoLines shows each relay status with its mark and label', () => {
  const relay: RelayItem[] = [
    { title: 'a', status: 'working' },
    { title: 'b', status: 'reviewing' },
    { title: 'c', status: 'passed' },
    { title: 'd', status: 'rejected' },
  ]
  expect(lineTexts(todoLines({ todos: [], relay }, null, 8))).toEqual([
    '릴레이 To-Do',
    ' ▶ a  개발 중',
    ' ◇ b  검수 중',
    ' ☑ c  통과',
    ' ✗ d  반려',
  ])
})

test('todoLines hides dev Todos that belong to another instruction', () => {
  const relay: RelayItem[] = [{ title: '2차', status: 'working' }]
  const dev = { todos: [todo('1', '옛 단계')], todoFor: '1차' }
  expect(lineTexts(todoLines({ todos: [], relay }, dev, 8))).toEqual(['릴레이 To-Do', ' ▶ 2차  개발 중'])
})

test('todoLines puts dev Todos under the todoFor title when there is no plan partner', () => {
  const dev = { todos: [todo('1', '단계', 'in_progress')], todoFor: '1차' }
  expect(lineTexts(todoLines(null, dev, 8))).toEqual(['릴레이 To-Do  완료 0/1', ' 1차', '    ▶ 단계'])
  // Todo가 없으면 제목만 따로 그리지 않는다. 이름표 옆의 작업 제목과 겹친다.
  expect(todoLines(null, { todos: [], todoFor: '1차' }, 8)).toEqual([])
})

test('todoLines draws nothing when both sides are empty', () => {
  expect(todoLines({ todos: [], relay: [] }, { todos: [], todoFor: null }, 8)).toEqual([])
  expect(todoLines(null, null, 8)).toEqual([])
})

test('todoLines keeps at least three plan lines and gives the rest to the relay', () => {
  const relay: RelayItem[] = [{ title: '1차', status: 'working' }]
  const plan = { todos: ['p1', 'p2', 'p3', 'p4'].map((text, i) => todo(String(i + 1), text)), relay }
  const dev = {
    todos: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((text, i) => todo(String(i + 1), text)),
    todoFor: '1차',
  }
  expect(lineTexts(todoLines(plan, dev, 8))).toEqual([
    '기획 To-Do  완료 0/4',
    ' ☐ p1',
    ' ☐ p2',
    '릴레이 To-Do  완료 0/6',
    ' ▶ 1차  개발 중',
    '    ☐ d1',
    '    ☐ d2',
    '    ☐ d3',
  ])
  // 릴레이가 적게 쓰면 기획이 남은 줄을 쓴다.
  expect(lineTexts(todoLines(plan, null, 8))).toEqual([
    '기획 To-Do  완료 0/4',
    ' ☐ p1',
    ' ☐ p2',
    ' ☐ p3',
    ' ☐ p4',
    '릴레이 To-Do',
    ' ▶ 1차  개발 중',
  ])
})

test('todoLines fits a smaller limit and draws nothing without room', () => {
  const relay: RelayItem[] = [{ title: '1차', status: 'working' }]
  const plan = { todos: [todo('1', 'p1'), todo('2', 'p2')], relay }
  expect(lineTexts(todoLines(plan, null, 4))).toEqual(['기획 To-Do  완료 0/2', ' ☐ p1', ' ☐ p2', '릴레이 To-Do'])
  expect(todoLines(plan, null, 0)).toEqual([])
  expect(todoLines(plan, null, -1)).toEqual([])
})

test('isAllDone is true only when every step is completed and every relay row passed', () => {
  const done: AgentTodo = { text: 'a', status: 'completed' }
  const passed: RelayItem = { title: 'x', status: 'passed' }
  expect(isAllDone([done], [passed])).toBe(true)
  expect(isAllDone([done], [])).toBe(true)
  expect(isAllDone([], [passed])).toBe(true)
  expect(isAllDone([], [])).toBe(false)
  expect(isAllDone([{ text: 'b', status: 'in_progress' }], [passed])).toBe(false)
  expect(isAllDone([done], [{ title: 'x', status: 'rejected' }])).toBe(false)
  expect(isAllDone([done], [{ title: 'x', status: 'reviewing' }])).toBe(false)
})

test('applyTaskList keeps only the tasks Claude Code still lists, with their current state', () => {
  const todos: AgentTodo[] = [
    { id: '22', text: '오래된 단계', status: 'in_progress' },
    { id: '30', text: '이름 바뀔 단계', status: 'pending' },
    { text: 'TodoWrite 단계', status: 'pending' },
  ]
  const listed = { tasks: [{ id: '30', subject: '새 이름', status: 'completed', blockedBy: [] }] }
  expect(applyTaskList(todos, listed)).toEqual([
    { text: 'TodoWrite 단계', status: 'pending' },
    { id: '30', text: '새 이름', status: 'completed' },
  ])
  expect(applyTaskList(todos, { tasks: [] })).toEqual([{ text: 'TodoWrite 단계', status: 'pending' }])
  expect(applyTaskList(todos, { tasks: [{ id: 3 }] })).toBe(todos)
  expect(applyTaskList(todos, null)).toBe(todos)
})
