import { expect, test } from 'claude-code/testing'

import { artFor } from './art'
import {
  buildReport,
  dayStamp,
  entry,
  expandHome,
  firstLine,
  logPath,
  parseRoles,
  rolesPath,
  parseTag,
  planGuide,
  REPORT_LIMIT,
  tagLine,
  timeStamp,
  unwrap,
  withTag,
} from './core'

// 2026-10-13 23:30:00 UTC = 2026-10-14 08:30:00 KST
const MS = Date.UTC(2026, 9, 13, 23, 30, 0)

test('dayStamp and timeStamp use KST', () => {
  expect(dayStamp(MS)).toBe('2026-10-14')
  expect(timeStamp(MS)).toBe('08:30:00')
  expect(logPath('/logs/control-center', MS)).toBe('/logs/control-center/2026-10-14.md')
  expect(rolesPath('/logs/control-center')).toBe('/logs/control-center/roles.json')
})

test('firstLine skips blank lines and cuts at 80 chars', () => {
  expect(firstLine('\n\n  TMS 경로 API 추가  \n상세')).toBe('TMS 경로 API 추가')
  expect(firstLine('x'.repeat(100))).toHaveLength(80)
  expect(firstLine('')).toBe('')
})

test('entry formats a markdown section', () => {
  expect(entry(MS, '[개발] 수신', '본문')).toBe('\n## 08:30:00 [개발] 수신\n본문\n')
})

test('parseRoles returns null for broken or non-object JSON', () => {
  expect(parseRoles('{broken')).toBeNull()
  expect(parseRoles('null')).toBeNull()
  expect(parseRoles('[1]')).toBeNull()
  expect(parseRoles('{"plan":{"sessionId":"S1","updatedAt":"t"}}')?.plan?.sessionId).toBe('S1')
})

test('buildReport lists files and commands', () => {
  const report = buildReport(
    { source: 'plan', title: '경로 API', prompt: '경로 API 추가' },
    '완료했습니다.',
    ['acs/Foo.java'],
    [{ command: './gradlew test', isOk: false }],
    REPORT_LIMIT,
    '/log.md',
  )
  expect(report).toContain('[개발 보고] 경로 API')
  expect(report).toContain('- acs/Foo.java')
  expect(report).toContain('- 실패: ./gradlew test')
  expect(report).not.toContain('전체 내용')
  expect(report).not.toContain('추가로 받은 지시')
})

test('buildReport lists instructions that arrived during the task', () => {
  const report = buildReport(
    { source: 'plan', title: '첫 작업', prompt: '첫 작업', extra: ['둘째 작업'] },
    'done',
    [],
    [],
    REPORT_LIMIT,
    '/log.md',
  )
  expect(report).toContain('추가로 받은 지시:\n- 둘째 작업')
})

test('buildReport cuts a long answer and points to the log', () => {
  const report = buildReport(
    { source: 'plan', title: 't', prompt: 't' },
    'a'.repeat(REPORT_LIMIT + 10),
    [],
    [],
    REPORT_LIMIT,
    '/log.md',
  )
  expect(report).toContain('a'.repeat(REPORT_LIMIT))
  expect(report).not.toContain('a'.repeat(REPORT_LIMIT + 1))
  expect(report).toContain('전체 내용: /log.md')
  expect(report).toContain('- 없음')
})

test('tagLine, withTag and parseTag round-trip the sender', () => {
  expect(tagLine('dev', 'S-DEV')).toBe('[plan-dev-relay role=dev session=S-DEV]')
  const tagged = withTag('본문\n둘째 줄', 'dev', 'S-DEV')
  expect(withTag(tagged, 'dev', 'S-DEV')).toBe(tagged)
  expect(parseTag(tagged)).toEqual({
    sender: { role: 'dev', sessionId: 'S-DEV' },
    body: '본문\n둘째 줄',
  })
})

test('parseTag finds a tag after an envelope line and ignores untagged text', () => {
  expect(parseTag('From peer:\n[plan-dev-relay role=plan session=S1]\n지시').sender).toEqual({
    role: 'plan',
    sessionId: 'S1',
  })
  expect(parseTag('그냥 메시지')).toEqual({ sender: null, body: '그냥 메시지' })
})

test('planGuide names the dev-session alias and what to do when no dev session is registered', () => {
  expect(planGuide()).toContain('to에는 "dev-session"')
  expect(planGuide()).toContain('/role dev')
})

// 엔진이 다른 세션의 메시지를 감싸는 형식 (실제 로그에서 가져옴)
const WRAPPED =
  '<cross-session-message from="uds:/tmp/cc-socks/4456.sock" from-name="control-center-48" from-mode="prompting">\n' +
  '작업 제목\n본문\n' +
  '</cross-session-message>'

test('firstLine skips the engine wrapper line', () => {
  expect(firstLine(WRAPPED)).toBe('작업 제목')
})

test('unwrap drops only the engine wrapper lines', () => {
  expect(unwrap(WRAPPED)).toBe('작업 제목\n본문')
  expect(unwrap('그냥 메시지')).toBe('그냥 메시지')
})

test('artFor draws five lines per role and animates', () => {
  for (const role of ['plan', 'dev'] as const) {
    expect(artFor(role, 0)).toHaveLength(5)
    expect(artFor(role, 0)).not.toEqual(artFor(role, 2))
  }
  expect(artFor('plan', 0).join('\n')).toContain('.oO(')
  expect(artFor('dev', 0).join('\n')).toContain('>_')
})

test('expandHome replaces a leading ~ with the home folder only', () => {
  expect(expandHome('~/Documents/claude/plan-dev-log', '/Users/kim')).toBe(
    '/Users/kim/Documents/claude/plan-dev-log',
  )
  expect(expandHome('~', '/Users/kim')).toBe('/Users/kim')
  expect(expandHome('/var/logs', '/Users/kim')).toBe('/var/logs')
  expect(expandHome('/var/~logs', '/Users/kim')).toBe('/var/~logs')
})
