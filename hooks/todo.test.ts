import { expect, test } from 'claude-code/testing'

import type { AgentTodo } from '../types'
import { applyTaskCreate, applyTaskUpdate, applyTodoWrite } from './todo'

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
