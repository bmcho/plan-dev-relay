import { expect, test } from 'claude-code/testing'

import { artFor } from './art'
import {
  buildReport,
  dayStamp,
  entry,
  expandHome,
  firstLine,
  logPath,
  parseRelayArgs,
  parseRoles,
  rolesPath,
  parseStop,
  parseTag,
  parseVerdict,
  planGuide,
  REPORT_LIMIT,
  reviewGuide,
  reviewHeader,
  reviewStatus,
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

test('planGuide lets the plan session run checks for an inspection but not edit code', () => {
  expect(planGuide()).toContain('구현과 수정은 직접 하지 말고')
  expect(planGuide()).toContain('테스트 실행')
  expect(planGuide()).toContain('완료 조건은 검수할 수 있게 항목별로')
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

test('parseRelayArgs reads status, manual, auto and an auto limit of 1 to 10', () => {
  expect(parseRelayArgs('')).toEqual({ mode: 'status' })
  expect(parseRelayArgs('manual')).toEqual({ mode: 'manual' })
  expect(parseRelayArgs('auto')).toEqual({ mode: 'auto', max: 3 })
  expect(parseRelayArgs(' auto  5 ')).toEqual({ mode: 'auto', max: 5 })
  expect(parseRelayArgs('auto 10')).toEqual({ mode: 'auto', max: 10 })
  expect(parseRelayArgs('auto 0')).toBeNull()
  expect(parseRelayArgs('auto 11')).toBeNull()
  expect(parseRelayArgs('auto 2.5')).toBeNull()
  expect(parseRelayArgs('auto x')).toBeNull()
  expect(parseRelayArgs('manual 3')).toBeNull()
  expect(parseRelayArgs('fast')).toBeNull()
})

test('reviewHeader asks for an inspection report and lets the plan re-instruct only with a round', () => {
  const retry = reviewHeader({ mode: 'auto', round: 2, max: 3 })
  const inspectOnly = reviewHeader(null)

  expect(retry.startsWith('[plan-dev-relay 검수 요청 오토 2/3]')).toBe(true)
  expect(retry).toContain('완료 조건')
  expect(retry).toContain('git diff')
  expect(retry).toContain('[검수 보고]')
  expect(retry).toContain('검수 결과:')
  expect(retry).toContain('SendMessage로 "dev-session"에 다시 지시')
  expect(inspectOnly.startsWith('[plan-dev-relay 검수 요청]')).toBe(true)
  expect(inspectOnly).toContain('다시 지시하지 않는다')
  expect(inspectOnly).not.toContain('SendMessage')
  // 형식 안내 줄은 판정으로 읽히지 않는다
  expect(parseVerdict(retry)).toBeNull()
})

test('automatic re-instruction carries only the fixes from this inspection', () => {
  const scope = '다시 지시에는 이번 검수에서 나온 고칠 점만 담는다. 새 작업이나 다음 단계는 지시하지 않는다.'

  expect(reviewHeader({ mode: 'auto', round: 1, max: 3 })).toContain(scope)
  expect(reviewHeader({ mode: 'full', round: 1, max: 20 })).not.toContain(scope)
  expect(reviewGuide({ mode: 'auto', max: 3, rounds: 0 })).toContain(scope)
  expect(reviewHeader(null)).not.toContain(scope)
})

test('parseVerdict reads the verdict line in common markdown forms', () => {
  expect(parseVerdict('[검수 보고] 경로 API\n검수 결과: 통과')).toBe('통과')
  expect(parseVerdict('**검수 결과:** 반려 — 테스트 없음')).toBe('반려')
  expect(parseVerdict('- **검수 결과**: 반려')).toBe('반려')
  expect(parseVerdict('## 검수 결과: 통과')).toBe('통과')
  expect(parseVerdict('검수 결과는 나중에 알려 드립니다. 통과')).toBeNull()
  expect(parseVerdict('확인했습니다.')).toBeNull()
})

test('buildReport puts the original instruction under 검수 기준 without the engine wrapper', () => {
  const report = buildReport(
    { source: 'plan', title: '경로 API', prompt: WRAPPED },
    '완료했습니다.',
    [],
    [],
    REPORT_LIMIT,
    '/log.md',
  )
  expect(report).toContain('검수 기준 (원래 지시):\n작업 제목\n본문')
  expect(report).not.toContain('cross-session-message')
})

test('buildReport cuts a long original instruction and points to the log', () => {
  const report = buildReport(
    { source: 'plan', title: 't', prompt: 'b'.repeat(REPORT_LIMIT + 10) },
    'done',
    [],
    [],
    REPORT_LIMIT,
    '/log.md',
  )
  expect(report).not.toContain('b'.repeat(REPORT_LIMIT + 1))
  expect(report).toContain('전체 내용: /log.md')
})

test('parseRelayArgs reads full auto with a limit of 1 to 50', () => {
  expect(parseRelayArgs('full')).toEqual({ mode: 'full', max: 20 })
  expect(parseRelayArgs('full 50')).toEqual({ mode: 'full', max: 50 })
  expect(parseRelayArgs('full 0')).toBeNull()
  expect(parseRelayArgs('full 51')).toBeNull()
  expect(parseRelayArgs('full 3 x')).toBeNull()
})

test('the full-auto header lets the plan decide and move on, but stop before risky work', () => {
  const header = reviewHeader({ mode: 'full', round: 3, max: 20 })

  expect(header.startsWith('[plan-dev-relay 검수 요청 풀오토 3/20]')).toBe(true)
  expect(header).toContain('통과면 계획 문서에서 다음 작업을 정해 SendMessage로 지시')
  expect(header).toContain('사용자에게 묻지 않는다')
  expect(header).toContain('git push')
  expect(header).toContain('결정:')
  expect(header).toContain('사용자 확인 필요:')
  // 형식 안내 줄은 판정이나 멈춤으로 읽히지 않는다
  expect(parseVerdict(header)).toBeNull()
  expect(parseStop(header)).toBeNull()
})

test('parseStop reads why full auto stopped for the user', () => {
  expect(parseStop('검수 결과: 통과\n사용자 확인 필요: 운영 배포 승인')).toBe('운영 배포 승인')
  expect(parseStop('**사용자 확인 필요:** git push')).toBe('git push')
  expect(parseStop('사용자 확인 필요: 없음')).toBeNull()
  expect(parseStop('- 사용자 확인 필요: 없음 (계획 완료)')).toBeNull()
  expect(parseStop('검수 결과: 통과')).toBeNull()
})

test('reviewGuide and reviewStatus describe each mode with the user-facing names', () => {
  const full = { mode: 'full', max: 20, rounds: 2 } as const
  expect(reviewStatus({ mode: 'manual', max: 3, rounds: 0 })).toContain('수동')
  expect(reviewStatus({ mode: 'auto', max: 3, rounds: 1 })).toContain('모드: 오토')
  expect(reviewStatus(full)).toContain('모드: 풀오토')
  expect(reviewStatus(full)).toContain('최대 20회, 지금 2회 진행')
  expect(reviewGuide(full)).toContain('사용자 승인 없이')
  expect(reviewGuide(full)).toContain('계획과 진행 상태는 그 문서에 적고')
})
