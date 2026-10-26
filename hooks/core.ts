import type { ModelEffort } from 'claude-code'

import type { CommandRun, Review, Role, Task } from '../types'

// userConfig.logRoot의 기본값. ~는 각자의 홈 폴더로 바뀐다.
export const DEFAULT_LOG_ROOT = '~/Documents/claude/plan-dev-log'
export const REPORT_LIMIT = 8000

// userConfig.maxAgents와 userConfig.subagentEffort의 기본값
export const DEFAULT_MAX_AGENTS = 3
export const DEFAULT_EFFORT = 'haiku=low sonnet=high opus=max'

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
const LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies ModelEffort[]

export type EffortLevels = Partial<Record<(typeof FAMILIES)[number], ModelEffort>>

// "haiku=low sonnet=high"처럼 공백이나 쉼표로 나눈 모델=레벨 쌍을 읽는다. 알아보지 못한 쌍은 bad에 남긴다.
export const parseEffort = (text: string) => {
  const levels: EffortLevels = {}
  const bad: string[] = []
  for (const pair of text.split(/[\s,]+/).filter(Boolean)) {
    const [name = '', level = '', ...rest] = pair.toLowerCase().split('=')
    const family = FAMILIES.find(known => known === name)
    if (family !== undefined && LEVELS.includes(level) && rest.length === 0) levels[family] = level as ModelEffort
    else bad.push(pair)
  }
  return { levels, bad }
}

// 모델 id에 든 이름으로 레벨을 고른다. 새 버전의 id에도 그대로 맞는다.
export const effortFor = (model: string, levels: EffortLevels) => {
  const family = FAMILIES.find(name => model.includes(name))
  return family === undefined ? undefined : levels[family]
}

// 0이면 제한하지 않는다. 0 이상의 정수가 아니면 기본값을 쓴다.
export const agentCap = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_AGENTS

// 호출이 model을 비운 Explore는 haiku 별칭으로 띄운다. 별칭은 Claude Code가 최신 모델로 바꾼다.
// 다른 종류는 세션 모델이나 자기 정의를 따른다. sonnet은 메인이 안내문 기준으로 직접 고른다.
export const defaultModel = (subagentType: string) => (subagentType === 'Explore' ? 'haiku' : undefined)

const KST_MS = 9 * 60 * 60 * 1000

export type Roles = Partial<Record<Role, { sessionId: string; updatedAt: string }>>

export const roleLabel = (role: Role) => (role === 'plan' ? '기획' : '개발')

export const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path

export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

// dir: 한 repo의 로그 폴더 (<logRoot>/<repo 이름>)
export const rolesPath = (dir: string) => `${dir}/roles.json`

// 역할별 To-Do 공유 파일. 각 세션은 자기 파일만 쓰고 상대 파일만 읽는다.
export const todoPath = (dir: string, role: Role) => `${dir}/todo-${role}.json`

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

// 봉투에 적힌 보낸 쪽의 주소(from)와 이름(from-name). 기획 모델이 이 값으로 답장하기도 한다.
export const envelopeNames = (text: string) => {
  const open = /<cross-session-message\s([^>]*)>/.exec(text)?.[1] ?? ''
  return [...open.matchAll(/\b(?:from|from-name)="([^"]*)"/g)]
    .map(found => found[1] ?? '')
    .filter(name => name !== '')
}

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

// 두 역할 모두 서브에이전트를 띄운다. 모델 기본값과 상한은 mod가 agent.spawn에서 적용한다.
const SUBAGENTS = [
  '서브에이전트 model 기준: 찾기·조사는 Explore로 띄운다(mod가 haiku로 띄운다). 여러 파일 요약, 기계적 변환처럼 양이 많고 판단이 적은 일은 `model: "sonnet"`을 적는다. 설계, 구현, 검수처럼 판단이 필요한 일은 model을 비워 세션 모델을 쓴다.',
  '동시에 일하는 서브에이전트가 상한에 닿으면 mod가 새 에이전트를 거절한다. 그때는 일하는 에이전트가 끝난 뒤 다시 띄우거나 직접 한다.',
]

export const planGuide = () =>
  [
    '# plan-dev-relay: 기획 역할',
    '이 세션은 기획 담당이다. 구현과 수정은 직접 하지 말고 개발 세션에 지시한다.',
    '서브에이전트에게도 구현이나 수정을 맡기지 않는다. 서브에이전트는 찾기, 조사, 설계 비교, 검수 보조에만 쓴다.',
    `지시는 SendMessage로 보내고, to에는 "${DEV_ALIAS}"를 쓴다. mod가 등록된 개발 세션으로 전달한다.`,
    'SendMessage가 지연 로드 도구이면 ToolSearch로 먼저 불러온다.',
    '개발 세션이 등록되지 않았으면 mod가 이유와 함께 거절한다. 그때는 사용자에게 다른 세션에서 `/role dev` 입력을 요청한다.',
    '지시에는 첫 줄에 작업 제목, 이어서 목표, 대상 파일, 완료 조건을 적는다. 완료 조건은 검수할 수 있게 항목별로 적는다.',
    '개발 세션의 보고가 오면 mod가 검수를 요청한다. 검수 때는 파일 읽기, git diff, 테스트 실행을 직접 한다. 보고를 기다리며 폴링하지 않는다.',
    '계획 단계도 TaskCreate·TaskUpdate(없으면 TodoWrite)로 적고 진행에 맞춰 상태를 바꾼다. 이 목록은 개발 세션 화면에도 보인다.',
    ...SUBAGENTS,
  ].join('\n')

export const DEFAULT_REVIEW_ROUNDS = 3
export const DEFAULT_FULL_ROUNDS = 20

export const RELAY_USAGE = '사용법: /relay [manual | auto [1-10] | full [1-50]]'

export const MODE_LABEL: Record<Review['mode'], string> = { manual: '수동', auto: '오토', full: '풀오토' }

export type RelayArgs = { mode: 'status' } | { mode: 'manual' } | { mode: 'auto' | 'full'; max: number }

// 모드별 기본 횟수와 상한
const LIMITS = {
  auto: { fallback: DEFAULT_REVIEW_ROUNDS, top: 10 },
  full: { fallback: DEFAULT_FULL_ROUNDS, top: 50 },
} as const

export const parseRelayArgs = (args: string): RelayArgs | null => {
  const [word = '', count, ...rest] = args.trim().split(/\s+/)
  if (rest.length > 0) return null
  if (word === '') return { mode: 'status' }
  if (word === 'manual') return count === undefined ? { mode: 'manual' } : null
  if (word !== 'auto' && word !== 'full') return null
  const { fallback, top } = LIMITS[word]
  if (count === undefined) return { mode: word, max: fallback }
  const max = Number(count)
  return Number.isInteger(max) && max >= 1 && max <= top ? { mode: word, max } : null
}

export const reviewStatus = (review: Review) => {
  const progress = `최대 ${review.max}회, 지금 ${review.rounds}회 진행`
  if (review.mode === 'auto') return `모드: 오토 (검수 후 반려면 기획이 고칠 점을 다시 지시, ${progress})`
  if (review.mode === 'full') return `모드: 풀오토 (검수, 다시 지시, 다음 작업 지시와 결정까지 기획이 함, ${progress})`
  return '모드: 수동 (검수만 하고, 다시 지시는 사용자가 정함)'
}

// prompt.submit에서 이 표시로 검수 요청이 들어간 turn을 알아본다.
export const REVIEW_MARK = '[plan-dev-relay 검수 요청'

// 사람 없이 이어 가는 단계. 없으면 검수만 하고 멈춘다.
export type Step = { mode: 'auto' | 'full'; round: number; max: number }

// 오토의 다시 지시가 다음 단계 작업으로 번지지 않게 한다.
const RETRY_SCOPE = '다시 지시에는 이번 검수에서 나온 고칠 점만 담는다. 새 작업이나 다음 단계는 지시하지 않는다.'

const FULL_DECIDE =
  '사용자에게 묻지 않는다. 선택이 필요하면 계획과 근거로 스스로 정하고, 결정과 근거를 지시와 검수 보고서의 결정 항목에 적는다.'

const FULL_STOP =
  '단, 되돌리기 어렵거나 바깥으로 나가는 작업(git push, 배포, 운영 데이터 삭제, 외부 전송)은 지시하지 않는다. ' +
  '검수 보고서의 사용자 확인 필요 항목에 이유를 적고 멈춘다.'

const NEXT: Record<'none' | Step['mode'], string[]> = {
  none: ['반려여도 개발 세션에 다시 지시하지 않는다. 다시 지시할지는 사용자가 정한다.'],
  auto: [`반려면 고칠 점을 SendMessage로 "${DEV_ALIAS}"에 다시 지시한다. ${RETRY_SCOPE} 통과면 더 지시하지 않는다.`],
  full: [
    `반려면 고칠 점을 SendMessage로 "${DEV_ALIAS}"에 다시 지시한다. 통과면 계획 문서에서 다음 작업을 정해 SendMessage로 지시한다. 계획이 모두 끝났으면 더 지시하지 않는다.`,
    FULL_DECIDE,
    FULL_STOP,
  ],
}

const REPORT_FORMAT = [
  '[검수 보고] <작업 제목>',
  '검수 결과: <통과 또는 반려>',
  '완료 조건 확인:',
  '- <조건>: <충족 또는 미충족> — <근거>',
  '확인 방법:',
  '- <실행한 명령이나 읽은 파일>: <결과>',
  '문제와 고칠 점: <반려일 때 고칠 점, 통과면 없음>',
]

const FULL_FORMAT = [
  '결정: <스스로 정한 것과 근거, 없으면 없음>',
  '다음 지시: <보낸 지시의 제목, 없으면 없음>',
  '사용자 확인 필요: <멈춘 이유, 멈추지 않았으면 없음>',
]

// 보고 맨 위에 붙여 기획 모델이 바로 검수하게 한다. step이 없으면 검수만 하고 멈춘다.
export const reviewHeader = (step: Step | null) => {
  const steps = [
    '보고의 검수 기준(원래 지시)에 적힌 완료 조건과 이 세션의 계획(계획 문서가 있으면 그 문서)에 맞는지 항목마다 확인한다.',
    '보고만 믿지 말고 git diff, 바뀐 파일 읽기, 테스트 실행으로 직접 확인한다. 코드는 고치지 않는다.',
    ...NEXT[step?.mode ?? 'none'],
    '이번 turn의 마지막 답변으로 아래 형식의 검수 보고서를 쓴다.',
  ]
  return [
    `${REVIEW_MARK}${step === null ? '' : ` ${MODE_LABEL[step.mode]} ${step.round}/${step.max}`}] 아래 개발 보고를 검수한다.`,
    ...steps.map((text, i) => `${i + 1}. ${text}`),
    ...REPORT_FORMAT,
    ...(step?.mode === 'full' ? FULL_FORMAT : []),
  ].join('\n')
}

// 모델이 굵게(**)나 목록(-)으로 감싸 써도 판정 줄로 읽는다.
const VERDICT = /^[\s>*#-]*검수 결과[\s*]*:[\s*]*(통과|반려)/m

export const parseVerdict = (answer: string): '통과' | '반려' | null => {
  const found = VERDICT.exec(answer)
  return found === null ? null : (found[1] as '통과' | '반려')
}

const STOP = /^[\s>*#-]*사용자 확인 필요[\s*]*:[\s*]*(.*)$/m

// 풀오토가 사용자 확인을 기다리며 멈춘 이유. '없음'이나 형식 안내 줄은 멈춤이 아니다.
export const parseStop = (answer: string) => {
  const reason = STOP.exec(answer)?.[1]?.trim() ?? ''
  return reason === '' || reason.startsWith('없음') || reason.startsWith('<') ? null : reason
}

const GUIDE: Record<Review['mode'], (max: number) => string[]> = {
  manual: () => ['모드: 수동. 반려여도 개발 세션에 다시 지시하지 않는다. 다시 지시할지는 사용자가 정한다.'],
  auto: max => [
    `모드: 오토. 반려면 SendMessage로 "${DEV_ALIAS}"에 고칠 점을 다시 지시한다. ${RETRY_SCOPE} 최대 ${max}회까지이고, 그 뒤에는 검수만 하고 다시 지시는 사용자가 정한다.`,
  ],
  full: max => [
    '모드: 풀오토. 기획, 계획, 결정, 검수, 다시 지시, 다음 작업 지시를 스스로 한다.',
    '사용자의 목표를 받으면 계획을 세워 계획 문서에 직접 적고, 사용자 승인 없이 바로 첫 작업을 지시한다. 설계나 계획 승인, 선택지 결정도 스스로 정한다.',
    '계획과 진행 상태는 그 문서에 적고, 다음 작업은 그 문서를 기준으로 정한다.',
    FULL_DECIDE,
    FULL_STOP,
    `사람 없이 이어 가는 검수는 최대 ${max}회까지다. 그 뒤에는 검수만 하고 멈춘다.`,
  ],
}

export const reviewGuide = (review: Review) =>
  [
    '# plan-dev-relay: 검수',
    '개발 세션의 보고는 모드와 관계없이 모두 검수한다. mod가 보고 앞에 검수 요청과 절차를 붙인다.',
    ...GUIDE[review.mode](review.max),
  ].join('\n')

export const devGuide = () =>
  [
    '# plan-dev-relay: 개발 역할',
    '이 세션은 개발 담당이다. 다른 세션이 보낸 메시지는 기획 세션의 작업 지시다.',
    '작업이 끝나면 결과가 기획 세션에 자동으로 보고된다. SendMessage로 기획 세션에 따로 답하지 않는다.',
    '마지막 답변에는 무엇을 바꿨는지, 테스트 결과, 남은 문제를 적는다.',
    '단계가 여럿인 지시는 TaskCreate·TaskUpdate(없으면 TodoWrite)로 단계를 적고 진행에 맞춰 상태를 바꾼다. 이 목록은 기획 세션 화면에도 보인다.',
    ...SUBAGENTS,
  ].join('\n')
