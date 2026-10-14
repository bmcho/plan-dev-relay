import type { CommandRun, Role, Task } from '../types'

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
  const body =
    answer.length > limit ? `${answer.slice(0, limit)}\n\n전체 내용: ${fullPath}` : answer
  const extra = task.extra ?? []
  return [
    `[개발 보고] ${task.title}`,
    '',
    body || '(답변 없음)',
    ...(extra.length > 0 ? ['', '추가로 받은 지시:', ...bullets(extra)] : []),
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
    '이 세션은 기획 담당이다. 구현, 수정, 테스트 작업은 직접 하지 말고 개발 세션에 지시한다.',
    `지시는 SendMessage로 보내고, to에는 "${DEV_ALIAS}"를 쓴다. mod가 등록된 개발 세션으로 전달한다.`,
    'SendMessage가 지연 로드 도구이면 ToolSearch로 먼저 불러온다.',
    '개발 세션이 등록되지 않았으면 mod가 이유와 함께 거절한다. 그때는 사용자에게 다른 세션에서 `/role dev` 입력을 요청한다.',
    '지시에는 첫 줄에 작업 제목, 이어서 목표, 대상 파일, 완료 조건을 적는다.',
    '개발 세션의 보고는 사용자의 다음 프롬프트와 함께 전달된다. 보고를 기다리며 폴링하지 않는다.',
  ].join('\n')

export const devGuide = () =>
  [
    '# plan-dev-relay: 개발 역할',
    '이 세션은 개발 담당이다. 다른 세션이 보낸 메시지는 기획 세션의 작업 지시다.',
    '작업이 끝나면 결과가 기획 세션에 자동으로 보고된다. SendMessage로 기획 세션에 따로 답하지 않는다.',
    '마지막 답변에는 무엇을 바꿨는지, 테스트 결과, 남은 문제를 적는다.',
  ].join('\n')
