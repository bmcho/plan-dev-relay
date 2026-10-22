import { expect, test } from 'claude-code/testing'

import type { AgentTodo, RelayItem } from '../types'
import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  parseShare,
  relayOnReport,
  relayOnSend,
  relayOnVerdict,
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
