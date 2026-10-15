import type { CommandRun, Review, Role, Task } from '../types'

// userConfig.logRoot의 기본값. ~는 각자의 홈 폴더로 바뀐다.
export const DEFAULT_LOG_ROOT = '~/Documents/claude/plan-dev-log'
export const REPORT_LIMIT = 8000

const KST_MS = 9 * 60 * 60 * 1000

export type Roles = Partial<Record<Role, { sessionId: string; updatedAt: string }>>

export const roleLabel = (role: Role) => (role === 'plan' ? '기획' : '개발')

export const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path

export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

// dir: 한 repo의 로그 폴더 (<logRoot>/<repo 이름>)
export const rolesPath = (dir: string) => `${dir}/roles.json`

export const dayStamp = (ms: number) => new Date(ms + KST_MS).toISOString().slice(0, 10)

export const timeStamp = (ms: number) => new Date(ms + KST_MS).toISOString().slice(11, 19)

export const logPath = (dir: string, ms: number) => `${dir}/${dayStamp(ms)}.md`

// 엔진이 다른 세션의 메시지를 감싸는 줄: <cross-session-message ...> 와 </cross-session-message>
const WRAPPER = /^<\/?cross-session-message(\s[^>]*)?>$/

export const unwrap = (text: string) =>
  text
    .split('\n')
    .filter(line => !WRAPPER.test(line.trim()))
    .join('\n')

export const firstLine = (text: string) =>
  (unwrap(text).split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, 80)

export const entry = (ms: number, tag: string, body: string) =>
  `\n## ${timeStamp(ms)} ${tag}\n${body}\n`

// 깨진 JSON이나 객체가 아닌 값은 null로 돌려준다. 호출하는 쪽이 알리고 빈 짝 정보로 본다.
export const parseRoles = (text: string): Roles | null => {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Roles)
      : null
  } catch {
    return null
  }
}

export type Sender = { role: Role; sessionId: string }

export const tagLine = (role: Role, sessionId: string) =>
  `[plan-dev-relay role=${role} session=${sessionId}]`

const TAG = /\[plan-dev-relay role=(plan|dev) session=([^\]\s]+)\]\n?/

export const withTag = (text: string, role: Role, sessionId: string) =>
  TAG.test(text) ? text : `${tagLine(role, sessionId)}\n${text}`

// 엔진이 peer 메시지 앞에 안내 줄을 붙일 수 있어 첫 줄로 고정하지 않는다.
export const parseTag = (text: string): { sender: Sender | null; body: string } => {
  const found = TAG.exec(text)
  return found === null
    ? { sender: null, body: text }
    : {
        sender: { role: found[1] as Role, sessionId: found[2] ?? '' },
        body: text.slice(0, found.index) + text.slice(found.index + found[0].length),
      }
}

const bullets = (items: string[]) => (items.length > 0 ? items.map(item => `- ${item}`) : ['- 없음'])

export const buildReport = (
  task: Task,
  answer: string,
  edits: string[],
  commands: CommandRun[],
  limit: number,
  fullPath: string,
) => {
  const clip = (text: string) =>
    text.length > limit ? `${text.slice(0, limit)}\n\n전체 내용: ${fullPath}` : text
  const extra = task.extra ?? []
  return [
    `[개발 보고] ${task.title}`,
    '',
    clip(answer) || '(답변 없음)',
    ...(extra.length > 0 ? ['', '추가로 받은 지시:', ...bullets(extra)] : []),
    '',
    // 기획 세션이 기억에 기대지 않고 완료 조건과 맞춰 볼 수 있게 원래 지시를 함께 보낸다.
    '검수 기준 (원래 지시):',
    clip(unwrap(task.prompt).trim()),
    '',
    '수정 파일 (Edit·Write 도구):',
    ...bullets(edits),
    '',
    '명령:',
    ...bullets(commands.map(run => `${run.isOk ? '성공' : '실패'}: ${run.command}`)),
  ].join('\n')
}

// SendMessage는 세션 id를 주소로 받지 않는다. 모델은 이 별칭으로 보내고 mod가 개발 세션으로 전달한다.
export const DEV_ALIAS = 'dev-session'

export const planGuide = () =>
  [
    '# plan-dev-relay: 기획 역할',
    '이 세션은 기획 담당이다. 구현과 수정은 직접 하지 말고 개발 세션에 지시한다.',
    `지시는 SendMessage로 보내고, to에는 "${DEV_ALIAS}"를 쓴다. mod가 등록된 개발 세션으로 전달한다.`,
    'SendMessage가 지연 로드 도구이면 ToolSearch로 먼저 불러온다.',
    '개발 세션이 등록되지 않았으면 mod가 이유와 함께 거절한다. 그때는 사용자에게 다른 세션에서 `/role dev` 입력을 요청한다.',
    '지시에는 첫 줄에 작업 제목, 이어서 목표, 대상 파일, 완료 조건을 적는다. 완료 조건은 검수할 수 있게 항목별로 적는다.',
    '개발 세션의 보고가 오면 mod가 검수를 요청한다. 검수 때는 파일 읽기, git diff, 테스트 실행을 직접 한다. 보고를 기다리며 폴링하지 않는다.',
  ].join('\n')

export const DEFAULT_REVIEW_ROUNDS = 3

export const RELAY_USAGE = '사용법: /relay [manual | auto [1-10]]'

export type RelayArgs = { mode: 'status' } | { mode: 'manual' } | { mode: 'auto'; max: number }

export const parseRelayArgs = (args: string): RelayArgs | null => {
  const [word = '', count, ...rest] = args.trim().split(/\s+/)
  if (rest.length > 0) return null
  if (word === '') return { mode: 'status' }
  if (word === 'manual') return count === undefined ? { mode: 'manual' } : null
  if (word !== 'auto') return null
  if (count === undefined) return { mode: 'auto', max: DEFAULT_REVIEW_ROUNDS }
  const max = Number(count)
  return Number.isInteger(max) && max >= 1 && max <= 10 ? { mode: 'auto', max } : null
}

export const reviewStatus = (review: Review) =>
  review.mode === 'auto'
    ? `다시 지시: 자동 (검수에서 반려면 기획이 다시 지시, 최대 ${review.max}회, 지금 ${review.rounds}회 진행)`
    : '다시 지시: 수동 (검수는 항상 하고, 반려 때 다시 지시는 사용자가 정함)'

// prompt.submit에서 이 표시로 검수 요청이 들어간 turn을 알아본다.
export const REVIEW_MARK = '[plan-dev-relay 검수 요청'

export type Retry = { round: number; max: number }

// 자동 모드의 다시 지시가 다음 단계 작업으로 번지지 않게 한다.
const RETRY_SCOPE = '다시 지시에는 이번 검수에서 나온 고칠 점만 담는다. 새 작업이나 다음 단계는 지시하지 않는다.'

// 보고 맨 위에 붙여 기획 모델이 바로 검수하게 한다. retry가 없으면 반려여도 다시 지시하지 않는다.
export const reviewHeader = (retry: Retry | null) =>
  [
    `${REVIEW_MARK}${retry === null ? '' : ` ${retry.round}/${retry.max}`}] 아래 개발 보고를 검수한다.`,
    '1. 보고의 검수 기준(원래 지시)에 적힌 완료 조건과 이 세션의 계획(계획 문서가 있으면 그 문서)에 맞는지 항목마다 확인한다.',
    '2. 보고만 믿지 말고 git diff, 바뀐 파일 읽기, 테스트 실행으로 직접 확인한다. 코드는 고치지 않는다.',
    retry === null
      ? '3. 반려여도 개발 세션에 다시 지시하지 않는다. 다시 지시할지는 사용자가 정한다.'
      : `3. 반려면 고칠 점을 SendMessage로 "${DEV_ALIAS}"에 다시 지시한다. ${RETRY_SCOPE} 통과면 더 지시하지 않는다.`,
    '4. 이번 turn의 마지막 답변으로 아래 형식의 검수 보고서를 쓴다.',
    '[검수 보고] <작업 제목>',
    '검수 결과: <통과 또는 반려>',
    '완료 조건 확인:',
    '- <조건>: <충족 또는 미충족> — <근거>',
    '확인 방법:',
    '- <실행한 명령이나 읽은 파일>: <결과>',
    '문제와 고칠 점: <반려일 때 고칠 점, 통과면 없음>',
  ].join('\n')

// 모델이 굵게(**)나 목록(-)으로 감싸 써도 판정 줄로 읽는다.
const VERDICT = /^[\s>*#-]*검수 결과[\s*]*:[\s*]*(통과|반려)/m

export const parseVerdict = (answer: string): '통과' | '반려' | null => {
  const found = VERDICT.exec(answer)
  return found === null ? null : (found[1] as '통과' | '반려')
}

export const reviewGuide = (review: Review) =>
  [
    '# plan-dev-relay: 검수',
    '개발 세션의 보고는 모드와 관계없이 모두 검수한다. mod가 보고 앞에 검수 요청과 절차를 붙인다.',
    review.mode === 'auto'
      ? `다시 지시: 자동. 반려면 SendMessage로 "${DEV_ALIAS}"에 고칠 점을 다시 지시한다. ${RETRY_SCOPE} 최대 ${review.max}회까지이고, 그 뒤에는 검수만 하고 다시 지시는 사용자가 정한다.`
      : '다시 지시: 수동. 반려여도 개발 세션에 다시 지시하지 않는다. 다시 지시할지는 사용자가 정한다.',
  ].join('\n')

export const devGuide = () =>
  [
    '# plan-dev-relay: 개발 역할',
    '이 세션은 개발 담당이다. 다른 세션이 보낸 메시지는 기획 세션의 작업 지시다.',
    '작업이 끝나면 결과가 기획 세션에 자동으로 보고된다. SendMessage로 기획 세션에 따로 답하지 않는다.',
    '마지막 답변에는 무엇을 바꿨는지, 테스트 결과, 남은 문제를 적는다.',
  ].join('\n')
