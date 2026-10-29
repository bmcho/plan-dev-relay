import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  Register,
  SessionSendResult,
  Timer,
  TurnCompleteReason,
} from 'claude-code'

import type { CommandRun, MainModel, Review, Role, Task, TodoShare } from '../types'
import { artFor, LABEL_STYLE, ORANGE } from './art'
import {
  AGENT_EFFORT_USAGE,
  agentCap,
  baseName,
  buildReport,
  dayStamp,
  DEFAULT_EFFORT,
  DEFAULT_LOG_ROOT,
  DEFAULT_REVIEW_ROUNDS,
  defaultModel,
  DEV_ALIAS,
  devGuide,
  effortFor,
  effortText,
  entry,
  envelopeNames,
  expandHome,
  firstLine,
  logPath,
  MODE_LABEL,
  modelLine,
  parseAgentEffort,
  parseCap,
  parseEffort,
  parseRelayArgs,
  parseRoles,
  parseStop,
  parseTag,
  parseVerdict,
  PLAN_GUARD_FAILED,
  PLAN_MAIN_DENY,
  PLAN_SUBAGENT_DENY,
  planGuide,
  planMay,
  RELAY_USAGE,
  REPORT_LIMIT,
  REVIEW_MARK,
  reviewGuide,
  reviewHeader,
  reviewStatus,
  roleLabel,
  rolesPath,
  SUBAGENTS_USAGE,
  todoPath,
  unwrap,
  withTag,
  type Roles,
  type Sender,
} from './core'
import {
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  applyTodoWrite,
  isAllDone,
  parseShare,
  relayOnReport,
  relayOnSend,
  relayOnVerdict,
  todoLines,
} from './todo'

const P = 'plan-dev-relay'
export const role = atom({ plugin: 'plan-dev-relay', key: 'role' } as const, null)
// 이 repo의 로그 폴더 (<logRoot>/<repo 이름>). /role 때 정한다.
export const dir = atom({ plugin: 'plan-dev-relay', key: 'dir' } as const, '')
export const frame = atom({ plugin: 'plan-dev-relay', key: 'frame' } as const, 0)
export const task = atom({ plugin: 'plan-dev-relay', key: 'task' } as const, null)
export const edits = atom({ plugin: 'plan-dev-relay', key: 'edits' } as const, [])
export const commands = atom({ plugin: 'plan-dev-relay', key: 'commands' } as const, [])
export const reviewing = atom({ plugin: 'plan-dev-relay', key: 'reviewing' } as const, false)
export const review = atom({ plugin: 'plan-dev-relay', key: 'review' } as const, {
  mode: 'manual',
  max: DEFAULT_REVIEW_ROUNDS,
  rounds: 0,
})
// 이 세션 에이전트의 To-Do. 완료 항목도 남긴다.
export const todos = atom({ plugin: 'plan-dev-relay', key: 'todos' } as const, [])
// 기획: 가장 최근 지시의 행
export const relay = atom({ plugin: 'plan-dev-relay', key: 'relay' } as const, [])
// 개발: todos가 속한 지시의 제목
export const todoFor = atom({ plugin: 'plan-dev-relay', key: 'todoFor' } as const, null)
// 2초마다 읽은 짝의 공유 파일
export const partner = atom({ plugin: 'plan-dev-relay', key: 'partner' } as const, null)
// 기획: 짝 개발 세션의 봉투에서 배운 주소와 이름
export const devNames = atom({ plugin: 'plan-dev-relay', key: 'devNames' } as const, null)
export const agents = atom({ plugin: 'plan-dev-relay', key: 'agents' } as const, [])
// 메인 loop의 마지막 모델 요청이 쓴 모델과 effort
export const mainModel = atom({ plugin: 'plan-dev-relay', key: 'mainModel' } as const, null)

// 엔진은 $를 받는 함수를 hook 모듈 파일 안에서만 따라간다. 그래서 입출력 함수는 이 파일에 둔다.
const repoName = async ($: EngineInterface) => {
  const found = await $.session.repo()
  const root = found?.root ?? (await $.session.root())
  return baseName(root) || 'unknown'
}

const readRoles = async ($: EngineInterface, logDir: string): Promise<Roles> => {
  const path = rolesPath(logDir)
  if (!(await $.fs.exists(path))) return {}
  const roles = parseRoles(String(await $.fs.read(path)))
  if (roles === null) {
    $.ui.log(`plan-dev-relay: ${path}가 깨져서 빈 짝 정보로 봅니다. 다음 /role 때 새로 씁니다.`)
  }
  return roles ?? {}
}

const writeRole = async (
  $: EngineInterface,
  logDir: string,
  next: Role,
  sessionId: string,
  ms: number,
) => {
  const roles = await readRoles($, logDir)
  roles[next] = { sessionId, updatedAt: new Date(ms).toISOString() }
  await $.fs.write(rolesPath(logDir), `${JSON.stringify(roles, null, 2)}\n`)
}

// 다른 세션이 같은 역할로 다시 등록했으면 그 항목은 남긴다. 이 세션이 역할을 갖고 있었는지 돌려준다.
const clearRole = async ($: EngineInterface, logDir: string, mine: Role, sessionId: string) => {
  const roles = await readRoles($, logDir)
  if (roles[mine]?.sessionId !== sessionId) return false
  delete roles[mine]
  await $.fs.write(rolesPath(logDir), `${JSON.stringify(roles, null, 2)}\n`)
  return true
}

// 두 세션이 같은 파일에 쓰므로 read+write 대신 O_APPEND(>>)로 덧붙인다.
const APPEND = [
  'mkdir -p "$(dirname "$1")"',
  '[ -f "$1" ] || printf "# %s plan-dev log %s\\n" "$2" "$3" > "$1"',
  'cat >> "$1"',
].join(' && ')

const appendLog = async ($: EngineInterface, logDir: string, ms: number, text: string) => {
  try {
    const path = logPath(logDir, ms)
    // Windows처럼 /bin/sh가 없으면 읽고 다시 쓴다. 제목 줄은 APPEND의 printf와 같다.
    // shortcut: 두 세션이 같은 순간에 쓰면 한쪽 항목이 빠질 수 있다, 자주 겹치면 세션별 로그 파일로 나눈다.
    if (!(await $.fs.exists('/bin/sh'))) {
      const before = (await $.fs.exists(path))
        ? String(await $.fs.read(path))
        : `# ${baseName(logDir)} plan-dev log ${dayStamp(ms)}\n`
      await $.fs.write(path, before + text)
      return
    }
    const ran = await $.process.run(['/bin/sh', '-c', APPEND, 'sh', path, baseName(logDir), dayStamp(ms)], {
      stdin: text,
    })
    if (ran.exitCode !== 0) {
      $.ui.log(`plan-dev-relay: 로그 쓰기 실패: ${ran.stderr.trim()}`)
    }
  } catch (error) {
    $.ui.log(`plan-dev-relay: 로그 쓰기 실패: ${String(error)}`)
  }
}

export const log = async ($: EngineInterface, tag: string, body: string) => {
  const logDir = await read($, dir)
  if (logDir === '') return
  const now = await $.clock.now()
  await appendLog($, logDir, now, entry(now, tag, body))
}

// 표식의 역할과 id가 roles.json의 짝과 같을 때만 짝으로 본다.
const partnerOf = async ($: EngineInterface, sender: Sender | null) => {
  const mine = await read($, role)
  if (mine === null || sender === null || sender.role === mine) return false
  const roles = await readRoles($, await read($, dir))
  return roles[sender.role]?.sessionId === sender.sessionId
}

// 2초 확인의 기억. 확인을 켤 때마다 새로 만든다.
type SyncMemo = { busy: boolean; written: string; writeFailed: boolean; seen: string }

const myShare = async ($: EngineInterface, mine: Role): Promise<TodoShare> => ({
  sessionId: await $.session.id(),
  todos: await read($, todos),
  relay: mine === 'plan' ? await read($, relay) : [],
  todoFor: mine === 'dev' ? await read($, todoFor) : null,
})

// 2초마다 읽으므로 깨진 roles.json을 알리지 않는다. 알림은 /role 때 readRoles가 한다. 없거나 깨졌으면 null.
const quietRoles = async ($: EngineInterface, logDir: string) => {
  try {
    return parseRoles(String(await $.fs.read(rolesPath(logDir))))
  } catch {
    return null
  }
}

const forget = async ($: EngineInterface, memo: SyncMemo) => {
  memo.seen = ''
  if ((await read($, partner)) !== null) await update($, partner, () => null)
}

// 내 몫은 바뀌었을 때만 쓰고, 상대 몫은 글이나 짝이 바뀌었을 때만 다시 파싱한다.
// 상태가 바뀔 때마다 바로 쓰지 않아서 병렬 도구 호출의 쓰기 순서가 꼬이지 않는다.
const sync = async ($: EngineInterface, memo: SyncMemo) => {
  const mine = await read($, role)
  const logDir = await read($, dir)
  if (mine === null || logDir === '') return

  const roles = await quietRoles($, logDir)
  const own = await myShare($, mine)
  const text = `${JSON.stringify(own)}\n`
  // 다른 세션이 내 역할을 가져갔으면 그 세션의 파일을 덮어쓰지 않는다. roles.json이 없거나 깨졌으면 계속 쓴다.
  const holder = roles?.[mine]?.sessionId
  if ((holder === undefined || holder === own.sessionId) && text !== memo.written) {
    try {
      await $.fs.write(todoPath(logDir, mine), text)
      memo.written = text
      memo.writeFailed = false
    } catch (error) {
      if (!memo.writeFailed) $.ui.log(`plan-dev-relay: To-Do 공유 파일 쓰기 실패: ${String(error)}`)
      memo.writeFailed = true
    }
  }

  const other: Role = mine === 'plan' ? 'dev' : 'plan'
  const partnerId = roles?.[other]?.sessionId
  if (partnerId === undefined) return forget($, memo)
  let found: string
  try {
    found = String(await $.fs.read(todoPath(logDir, other)))
  } catch {
    return forget($, memo)
  }
  const key = `${partnerId}\n${found}`
  if (key === memo.seen) return
  memo.seen = key
  const share = parseShare(found)
  // 깨진 글은 무시하고 직전 값을 유지한다. 다른 세션이 남긴 옛 파일이면 짝이 없는 것으로 본다.
  if (share !== null) await update($, partner, () => (share.sessionId === partnerId ? share : null))
}

// 새 기억으로 2초 타이머를 켠다. 앞 차례가 아직 끝나지 않았으면 이번 차례는 건너뛴다.
// $를 받으므로 register 안이 아니라 파일 최상위에 둔다.
const syncTimer = ($: EngineInterface) => {
  const memo: SyncMemo = { busy: false, written: '', writeFailed: false, seen: '' }
  return $.clock.every(2000, () => {
    if (memo.busy) return
    memo.busy = true
    void sync($, memo)
      .catch(error => $.ui.log(`plan-dev-relay: To-Do 공유 실패: ${String(error)}`))
      .finally(() => {
        memo.busy = false
      })
  })
}

const startTask = async ($: EngineInterface, next: Task) => {
  const current = await read($, task)
  // 기획 지시가 새 작업을 시작하면 To-Do를 그 지시의 것으로 새로 시작한다. 추가 지시는 그대로 둔다.
  if (next.source === 'plan' && current?.source !== 'plan') {
    await update($, todos, () => [])
    await update($, todoFor, () => next.title)
  }
  if (current === null) {
    await update($, task, () => next)
    await update($, edits, () => [])
    await update($, commands, () => [])
  } else if (current.source === 'direct' && next.source === 'plan') {
    // 직접 작업 중에 온 지시도 turn이 끝나면 보고한다. 지금까지의 기록은 유지한다.
    await update($, task, () => next)
  } else if (current.source === 'plan' && next.source === 'plan') {
    // 작업 중에 온 지시는 보고에 함께 적는다.
    await update($, task, t => (t === null ? t : { ...t, extra: [...(t.extra ?? []), next.title] }))
  }
}

// 전송이 예외로 끝나도 거절과 같게 다룬다. 보고나 지시가 조용히 사라지지 않게 한다.
const sendSafely = async (
  $: EngineInterface,
  sessionId: string,
  text: string,
): Promise<SessionSendResult> => {
  try {
    return await $.session.send({ to: { sessionId }, text })
  } catch (error) {
    return { isDelivered: false, reason: String(error) }
  }
}

// /config의 이 mod 설정 한 칸을 바꾼다. 바뀐 설정으로 mod가 다시 불려 두 세션 모두에 적용된다.
const saveConfig = async ($: EngineInterface, field: string, value: number | string, done: string) => {
  const saved = await $.config.set({ key: `${P}.${field}`, value })
  return { text: saved.deny === undefined ? done : `설정을 바꾸지 못했습니다: ${saved.deny}` }
}

const ENDING: Partial<Record<TurnCompleteReason, string>> = {
  aborted: '(중단됨)',
  error: '(오류로 종료)',
  refusal: '(거절로 종료)',
}

const finishTask = async ($: EngineInterface, answer: string, reason: TurnCompleteReason) => {
  const done = await read($, task)
  if (done === null) return
  const files = await read($, edits)
  const runs: CommandRun[] = await read($, commands)
  await update($, task, () => null)

  const logDir = await read($, dir)
  const now = await $.clock.now()
  const ending = ENDING[reason]
  const full = ending === undefined ? answer : `${ending}\n${answer}`

  if (done.source === 'direct') {
    await log($, '[개발] 직접 작업 완료', full || '(답변 없음)')
    return
  }

  const path = logPath(logDir, now)
  const devId = await $.session.id()
  const planId = (await readRoles($, logDir)).plan?.sessionId
  await log(
    $,
    `[개발→기획] 보고 (${devId} → ${planId ?? '없음'})`,
    buildReport(done, full, files, runs, Infinity, path),
  )

  if (planId === undefined) {
    await $.ui.toast('기획 세션 전달 실패: 등록된 기획 세션 없음')
    await log($, '[개발] 전달 실패', '등록된 기획 세션 없음')
    return
  }

  // plugin 자신의 $.session.send는 자기 session.send hook을 거치지 않을 수 있어 직접 표식을 붙인다.
  const sent = await sendSafely(
    $,
    planId,
    withTag(buildReport(done, full, files, runs, REPORT_LIMIT, path), 'dev', devId),
  )
  if (!sent.isDelivered) {
    await $.ui.toast(`기획 세션 전달 실패: ${sent.reason}`)
    await log($, '[개발] 전달 실패', sent.reason)
  }
}

// 검수 요청이 들어간 turn의 마지막 답변이 검수 보고서다.
const finishReview = async ($: EngineInterface, answer: string, reason: TurnCompleteReason) => {
  await update($, reviewing, () => false)
  const verdict = parseVerdict(answer)
  if (verdict === null) {
    const ending = ENDING[reason]
    await $.ui.toast('검수 보고서 누락: 마지막 답변에 "검수 결과:" 줄이 없습니다')
    await log($, `[기획] 검수 보고 누락${ending === undefined ? '' : ` ${ending}`}`, answer || '(답변 없음)')
  } else {
    await update($, relay, rows => relayOnVerdict(rows, verdict))
    await $.ui.toast(`검수 ${verdict}: ${firstLine(answer)}`)
    await log($, `[기획] 검수 보고 (${verdict})`, answer)
  }
  // 풀오토가 되돌리기 어려운 작업 앞에서 멈췄으면 따로 알린다.
  const stop = parseStop(answer)
  if (stop !== null) {
    await $.ui.toast(`사용자 확인 필요: ${stop}`)
    await log($, '[기획] 사용자 확인 필요', stop)
  }
}

// 일하는 동안 캐릭터를 움직인다.
const frameTimer = ($: EngineInterface) => $.clock.every(200, () => void update($, frame, n => (n + 1) % 600))

const BUSY = new Set(['pending', 'running', 'waiting'])

// 메인 loop가 띄운 서브에이전트 중 아직 일하는 것을 다시 센다. 이것들은 끝나면 엔진이 알림으로 메인을 깨운다.
// 다른 plugin이 띄운 에이전트, 에이전트가 띄운 에이전트, 팀원, 목록에 없는 엔진의 fork는 메인을 깨운다는 보장이 없어 세지 않는다.
// ended는 막 turn을 끝낸 에이전트다. 목록의 상태가 늦게 바뀌어도 끝난 것으로 본다.
const refreshAgents = async ($: EngineInterface, ended?: string) => {
  let list: AgentInfo[] = []
  try {
    list = await $.agent.list()
  } catch (error) {
    // 목록을 못 읽으면 기다리지 않는다. 보고가 묶여 나가지 않는 것보다 낫다.
    $.ui.log(`plan-dev-relay: 에이전트 목록 읽기 실패: ${String(error)}`)
  }
  const ids = list
    .filter(agent => agent.parentId === undefined && agent.spawnedBy === undefined && agent.teammateId === undefined)
    .filter(agent => BUSY.has(agent.status) && agent.id !== ended)
    .map(agent => agent.id)
  await update($, agents, old =>
    old.length === ids.length && old.every((id, index) => id === ids[index]) ? old : ids,
  )
  return ids
}

// 못 읽으면 모델 표시만 빠진다. band 전체가 사라지게 하지 않는다.
const sessionModel = async ($: EngineInterface) => {
  try {
    return await $.session.model()
  } catch {
    return ''
  }
}

const USAGE = '사용법: /role plan | dev | off'

export const register: Register = (on, options) => {
  // hot reload 때 module 변수는 초기화된다. 다음 turn.start에서 다시 켠다.
  let timer: Timer | undefined
  let isMainTurn = false
  // 2초마다 내 To-Do 몫을 쓰고 상대 몫을 읽는다. hot reload 뒤에는 session.start에서 다시 켠다.
  let poll: Timer | undefined
  // 설정을 바꾸면 mod가 새 options로 다시 불려진다.
  const cap = agentCap(options.maxAgents)
  const efforts = parseEffort(typeof options.subagentEffort === 'string' ? options.subagentEffort : DEFAULT_EFFORT)
  // 한 메시지의 여러 Agent 호출은 spawn이 함께 돈다. 함께 읽은 목록은 서로의 에이전트를 세지 못하므로,
  // 앞 spawn의 에이전트가 목록에 오른 뒤에 다음 spawn을 세도록 하나씩 확인한다.
  let spawning: Promise<unknown> = Promise.resolve()

  const stopFrames = () => {
    timer?.cancel()
    timer = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'role', description: `plan-dev-relay 역할 지정. ${USAGE}` })
    await $.command.register({
      name: 'relay',
      description: `plan-dev-relay 검수 뒤 진행 방식 (수동/오토/풀오토). ${RELAY_USAGE}`,
    })
    await $.command.register({
      name: 'subagents',
      description: `plan-dev-relay 서브에이전트 동시 상한. ${SUBAGENTS_USAGE}`,
      argumentHint: '[n]',
    })
    await $.command.register({
      name: 'agentEffort',
      description: `plan-dev-relay 서브에이전트의 모델별 effort. ${AGENT_EFFORT_USAGE}`,
      argumentHint: '[model] [effort]',
    })
    // 다시 불러오거나 이어 연 세션에 지난 에이전트 목록이 남지 않게 다시 센다.
    // 다시 불러오면 타이머가 사라지므로, 에이전트가 일하는 중이면 캐릭터를 다시 움직인다.
    const working = await refreshAgents($)
    if (working.length > 0 && (await read($, role)) !== null) timer ??= frameTimer($)
    // hot reload 뒤에도 역할은 남아 있다. 2초 확인을 다시 켠다.
    if ((await read($, role)) !== null) {
      poll?.cancel()
      poll = syncTimer($)
    }
    if (efforts.bad.length > 0) {
      await $.ui.toast(`서브에이전트 effort 설정에서 무시한 값: ${efforts.bad.join(', ')} (형식: ${DEFAULT_EFFORT})`)
    }
    return next(e)
  })

  on('command.run', { command: 'role' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === '') {
      const mine = await read($, role)
      if (mine === null) return { text: `역할 없음. ${USAGE}` }
      const roles = await readRoles($, await read($, dir))
      const paired = mine === 'plan' ? roles.dev : roles.plan
      return {
        text: `${roleLabel(mine)} 역할. 상대 세션: ${paired?.sessionId ?? '없음'}`,
      }
    }

    if (arg === 'off') {
      stopFrames()
      poll?.cancel()
      poll = undefined
      const mine = await read($, role)
      if (mine !== null) {
        const logDir = await read($, dir)
        const sessionId = await $.session.id()
        // 상대 화면에서 내 목록이 사라지게 빈 몫을 남긴다. 역할을 가져간 다른 세션의 파일은 덮어쓰지 않는다.
        if (await clearRole($, logDir, mine, sessionId)) {
          const empty: TodoShare = { sessionId, todos: [], relay: [], todoFor: null }
          try {
            await $.fs.write(todoPath(logDir, mine), `${JSON.stringify(empty)}\n`)
          } catch (error) {
            $.ui.log(`plan-dev-relay: To-Do 공유 파일 쓰기 실패: ${String(error)}`)
          }
        }
      }
      await update($, partner, () => null)
      await update($, role, () => null)
      return { text: '역할을 지웠습니다.' }
    }

    if (arg !== 'plan' && arg !== 'dev') return { text: USAGE }

    const next: Role = arg
    const name = await repoName($)
    const configured =
      typeof options.logRoot === 'string' && options.logRoot !== '' ? options.logRoot : DEFAULT_LOG_ROOT
    // Windows는 홈 폴더가 HOME 대신 USERPROFILE에 있다.
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const root = expandHome(configured, home).replace(/[\\/]+$/, '')
    const logDir = `${root}/${name}`
    const sessionId = await $.session.id()
    await writeRole($, logDir, next, sessionId, await $.clock.now())
    await update($, dir, () => logDir)
    await update($, role, () => next)
    // 역할을 다시 맺으면 To-Do 목록도 새로 시작한다. 지난 일의 남은 단계가 계속 남지 않게 한다.
    await update($, todos, () => [])
    await update($, relay, () => [])
    await update($, todoFor, () => null)
    poll?.cancel()
    poll = syncTimer($)
    await log($, `[${roleLabel(next)}] 역할 등록`, `session: ${sessionId}`)
    // 시스템 프롬프트는 세션 시작 때 그려지므로, 역할 안내는 명령 결과의 context로 모델에 넘긴다.
    return {
      text: `${roleLabel(next)} 역할로 등록했습니다. (repo: ${name})`,
      context: [next === 'plan' ? planGuide() : devGuide()],
    }
  })
    // 실패하면 엔진은 "registered /role but no command.run hook answered it"만 보이고 이유는 debug 로그에만 남는다.
    // 데스크톱 앱처럼 터미널과 권한이 다른 곳에서는 logRoot 쓰기가 막힐 수 있어, 이유와 확인할 곳을 보인다.
    .catch(($, e, next) => {
      const reason = next.error.kind === 'timeout' ? '시간 초과' : (next.error.message ?? '알 수 없는 오류')
      return {
        text: `역할 명령 실패 (${reason}). 로그 폴더(설정의 logRoot)에 쓸 수 있는지 확인하세요. 데스크톱 앱은 문서 폴더 접근을 따로 허용해야 할 수 있습니다.`,
      }
    })

  on('command.run', { command: 'relay' }, async ($, e) => {
    const parsed = parseRelayArgs(e.args)
    if (parsed === null) return { text: RELAY_USAGE }
    const current = await read($, review)
    if (parsed.mode === 'status') return { text: reviewStatus(current) }
    if ((await read($, role)) !== 'plan') {
      return { text: '기획 세션에서만 쓸 수 있습니다. 먼저 /role plan을 입력하세요.' }
    }

    const next: Review =
      parsed.mode === 'manual'
        ? { mode: 'manual', max: current.max, rounds: 0 }
        : { mode: parsed.mode, max: parsed.max, rounds: 0 }
    await update($, review, () => next)
    await log($, '[기획] 릴레이 모드 변경', reviewStatus(next))
    return { text: reviewStatus(next), context: [reviewGuide(next)] }
  })

  // 설정을 못 바꾸면($.config.set이 거절하거나 실패하면) 이유를 보인다.
  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') return { text: `서브에이전트 상한: ${cap === 0 ? '없음' : `${cap}개`}. ${SUBAGENTS_USAGE}` }
    const next = parseCap(arg)
    if (next === null) return { text: SUBAGENTS_USAGE }
    const done = next === 0 ? '서브에이전트 상한을 없앴습니다.' : `서브에이전트 상한을 ${next}개로 바꿨습니다.`
    return saveConfig($, 'maxAgents', next, done)
  }).catch(($, e, next) => ({ text: `설정을 바꾸지 못했습니다: ${next.error.message ?? next.error.kind}` }))

  on('command.run', { command: 'agentEffort' }, async ($, e) => {
    if (e.args.trim() === '') {
      const current = effortText(efforts.levels) || '없음'
      return { text: `서브에이전트 effort: ${current} (적지 않은 모델은 세션 effort를 따른다). ${AGENT_EFFORT_USAGE}` }
    }
    const pair = parseAgentEffort(e.args)
    if (pair === null) return { text: AGENT_EFFORT_USAGE }
    const next = effortText({ ...efforts.levels, ...pair })
    return saveConfig($, 'subagentEffort', next, `서브에이전트 effort를 ${next}로 바꿨습니다.`)
  }).catch(($, e, next) => ({ text: `설정을 바꾸지 못했습니다: ${next.error.message ?? next.error.kind}` }))

  on('session.receive', async ($, e, next) => {
    const mine = await read($, role)
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (mine === null || !isPeer) return next(e)
    const { sender, body } = parseTag(e.text)
    if (sender === null || !(await partnerOf($, sender))) return next(e)
    const route = `(${sender.sessionId} → ${await $.session.id()})`

    if (mine === 'plan') {
      // 기획 모델이 이 보고의 봉투에 적힌 이름이나 주소로 답장해도 지시로 알아보게 배워 둔다.
      const names = envelopeNames(e.text)
      await update($, devNames, known => {
        const kept = known !== null && known.sessionId === sender.sessionId ? known.names : []
        return { sessionId: sender.sessionId, names: [...new Set([...kept, ...names])] }
      })
      await update($, relay, relayOnReport)
      const current = await read($, review)
      await log($, `[기획] 보고 수신 ${route}`, unwrap(body))

      // 검수는 모드와 관계없이 한다. 머리말을 붙여 넘기면 엔진이 기획 모델에 전달한다.
      // 오토와 풀오토는 한도 안에서만 사람 없이 이어 간다.
      const step =
        current.mode !== 'manual' && current.rounds < current.max
          ? { mode: current.mode, round: current.rounds + 1, max: current.max }
          : null
      if (step !== null) await update($, review, r => ({ ...r, rounds: r.rounds + 1 }))
      const label = MODE_LABEL[current.mode]
      const note =
        step !== null
          ? `${label} ${step.round}/${step.max}`
          : current.mode === 'manual'
            ? label
            : `${label} 한도 ${current.max}회 도달`
      const suffix = current.mode === 'manual' ? '' : `, ${note}`
      await $.ui.toast(`개발 보고 도착: ${firstLine(body)} (검수 시작${suffix})`)
      await log($, `[기획] 검수 요청 (${note})`, firstLine(body))
      return next({ ...e, text: `${reviewHeader(step)}\n${body}` })
    }

    await startTask($, { source: 'plan', title: firstLine(body), prompt: body })
    await log($, `[개발] 수신 ${route}`, unwrap(body))
    return next({ ...e, text: body })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const mine = await read($, role)
    if (mine === null) return composed
    const current = await read($, review)
    const text = mine === 'dev' ? devGuide() : `${planGuide()}\n\n${reviewGuide(current)}`
    return {
      sections: [...composed.sections, { id: `${P}:guide`, text, scope: 'session' as const }],
    }
  })

  on('session.send', async ($, e, next) => {
    const mine = await read($, role)
    if (mine === null || e.agentId !== undefined) return next(e)
    const myId = await $.session.id()
    const text = withTag(e.text, mine, myId)
    if (mine !== 'plan' || e.origin.kind !== 'model') return next({ ...e, text })

    const devId = (await readRoles($, await read($, dir))).dev?.sessionId
    // 기획 모델은 보고 봉투의 이름이나 주소로 답장하기도 한다. 지금 짝에게서 배운 값이면 지시로 본다.
    const learned = await read($, devNames)
    const isLearned = learned !== null && learned.sessionId === devId && learned.names.includes(e.to)
    if (e.to !== DEV_ALIAS && e.to !== devId && !isLearned) return next({ ...e, text })

    if (devId === undefined) {
      const reason = '등록된 개발 세션 없음. 사용자에게 다른 세션에서 /role dev 입력을 요청한다.'
      await $.ui.toast(`개발 세션 전달 실패: ${reason}`)
      await log($, '[기획] 전달 실패', reason)
      return { isDelivered: false, reason }
    }

    // SendMessage는 세션 id를 주소로 받지 않으므로 짝인 개발 세션에는 mod가 직접 보낸다.
    await log($, `[기획→개발] 지시 (${myId} → ${devId})`, parseTag(e.text).body)
    const sent = await sendSafely($, devId, text)
    if (sent.isDelivered) {
      await update($, relay, rows => relayOnSend(rows, firstLine(parseTag(e.text).body)))
    } else {
      await $.ui.toast(`개발 세션 전달 실패: ${sent.reason}`)
      await log($, '[기획] 전달 실패', sent.reason)
    }
    return sent
  })

  on('prompt.submit', async ($, e, next) => {
    const mine = await read($, role)
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (mine === 'plan' && isPeer && e.text.includes(REVIEW_MARK)) {
      // 검수 요청이 들어간 turn이다. peer 메시지는 실행 중인 turn에 들어가거나 새 turn을 연다.
      // 어느 쪽이든 다음 turn.complete의 마지막 답변이 검수 보고서다.
      const submitted = await next(e)
      if (submitted.drop === undefined) await update($, reviewing, () => true)
      return submitted
    }

    // 터미널 입력(composer)과 Remote Control 입력(bridge) 모두 사용자 본인의 프롬프트다.
    const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (mine === null || !isUser) return next(e)

    if (mine === 'dev') {
      await startTask($, { source: 'direct', title: firstLine(e.text), prompt: e.text })
      await log($, '[개발] 직접 입력', e.text)
      return next(e)
    }

    // 사용자가 직접 입력하면 자동으로 다시 지시한 횟수를 처음부터 다시 센다.
    await update($, review, r => (r.rounds === 0 ? r : { ...r, rounds: 0 }))
    return next(e)
  })

  // 기획 세션은 고치는 일을 개발 세션에 맡긴다. 서브에이전트의 파일 수정 도구와, 읽기·테스트가 아닌 Bash를 막는다.
  // 이 확인이 next 전에 실패하면 기획 세션에서는 막고, 다른 세션에서는 그대로 둔다(아래 .catch).
  on('tool.call', async ($, e, next) => {
    const mine = await read($, role)
    const isSubagent = e.agentId !== undefined
    // 메인의 Bash만 프로젝트 폴더(세션이 시작한 폴더) 기준으로 본다.
    const root = mine === 'plan' && !isSubagent && e.tool === 'Bash' ? await $.session.root() : ''
    if (mine === 'plan' && !planMay(e.tool, e.tool === 'Bash' ? e.command : undefined, isSubagent, root)) {
      return { deny: isSubagent ? PLAN_SUBAGENT_DENY : PLAN_MAIN_DENY }
    }
    const ran = await next(e)
    const current = await read($, task)
    const isOk = ran.deny === undefined && ran.isError !== true

    // 에이전트 To-Do: 메인 루프의 성공한 호출만 모은다. 개발은 기획 지시를 하는 동안만 모은다.
    const collects = mine === 'plan' || (mine === 'dev' && current?.source === 'plan')
    if (collects && isOk && e.agentId === undefined) {
      if (e.tool === 'TaskCreate') {
        await update($, todos, list => applyTaskCreate(list, ran.result))
      } else if (e.tool === 'TaskUpdate') {
        await update($, todos, list => applyTaskUpdate(list, e, ran.result))
      } else if (e.tool === 'TodoWrite') {
        await update($, todos, list => applyTodoWrite(list, e.todos))
      } else if (e.tool === 'TaskList') {
        await update($, todos, list => applyTaskList(list, ran.result))
      }
    }

    if (mine !== 'dev' || current === null) return ran

    if ((e.tool === 'Edit' || e.tool === 'Write') && isOk) {
      await update($, edits, list => (list.includes(e.file_path) ? list : [...list, e.file_path]))
      await log($, '[개발] 파일 수정', `\`${e.file_path}\``)
    } else if (e.tool === 'NotebookEdit' && isOk) {
      await update($, edits, list =>
        list.includes(e.notebook_path) ? list : [...list, e.notebook_path],
      )
      await log($, '[개발] 파일 수정', `\`${e.notebook_path}\``)
    } else if (e.tool === 'Bash') {
      await update($, commands, list => [...list, { command: e.command, isOk }])
      await log($, `[개발] 명령 ${isOk ? '성공' : '실패'}`, `\`${e.command}\``)
    }
    return ran
  }).catch(async ($, e, next) => (next.called || (await read($, role)) !== 'plan' ? next(e) : { deny: PLAN_GUARD_FAILED }))

  on('agent.spawn', async ($, e, next) => {
    // 메인 loop가 새로 띄우는 서브에이전트만 다룬다. 팀원, 워크플로 에이전트, 이어 하기는 그대로 둔다.
    const isNew =
      e.parentAgentId === undefined && e.isTeammate === undefined && e.workflow === undefined && e.resume === undefined
    const mine = await read($, role)
    if (!isNew || mine === null) return next(e)

    // 호출이 model을 비운 엔진 서브에이전트는 종류와 역할에 맞는 기본 모델로 띄운다.
    const model = e.model ?? (e.provider.plugin === 'engine' ? defaultModel(e.subagentType, mine) : undefined)
    const spawn = model === e.model ? e : { ...e, model }
    if (cap === 0) return next(spawn)
    const started = spawning.then(async () => {
      // 앞 spawn을 기다리는 동안 이 호출이 버려졌으면(사용자 중단, 시간 초과) 띄우지 않는다.
      if (next.signal.aborted) return { deny: '에이전트 호출이 중단되었습니다.' }
      if ((await refreshAgents($)).length < cap) return next(spawn)
      return {
        deny: `동시에 일하는 서브에이전트가 상한 ${cap}개에 닿았습니다. 일하는 에이전트가 끝난 뒤 다시 띄우거나 직접 하세요.`,
      }
    })
    spawning = started.catch(() => undefined)
    return started
  })

  // 메인 loop의 요청은 모델과 effort를 band에 보이려고 남기고, 서브에이전트의 요청마다 모델에 맞는 effort를 준다.
  // 메인 loop와 effort가 없는 모델의 effort는 그대로 둔다.
  on('turn.step', async function* ($, e, next) {
    const mine = await read($, role)
    if (mine !== null && e.agentId === undefined) {
      await update($, mainModel, old =>
        old?.model === e.model && old.effort === e.effort ? old : { model: e.model, effort: e.effort },
      )
    }
    const level =
      e.agentId === undefined || e.effort === undefined || mine === null
        ? undefined
        : effortFor(e.model, efforts.levels)
    return yield* next(level === undefined ? e : { ...e, effort: level })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isMainTurn = true
    const working = await refreshAgents($)
    if ((await read($, role)) !== null && (isMainTurn || working.length > 0)) timer ??= frameTimer($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) isMainTurn = false
    const working = await refreshAgents($, e.agentId)
    if (!isMainTurn && working.length === 0) stopFrames()
    if (e.agentId !== undefined) return result
    // 메인이 띄운 에이전트가 아직 일하면 그 일이 끝난 뒤에 마무리한다.
    // 에이전트가 끝나면 엔진이 알림으로 메인을 깨우고, 그 turn이 끝날 때 다시 본다.
    const waits = working.length > 0
    const mine = await read($, role)
    if (mine === 'dev' && !waits) await finishTask($, e.answer, e.reason)
    // 사용자가 직접 검수를 시킨 turn도 판정 줄이 있으면 검수 보고서로 남긴다.
    // 판정 줄이 있으면 에이전트를 기다리지 않는다.
    const hasVerdict = parseVerdict(e.answer) !== null
    if (mine === 'plan' && (hasVerdict || ((await read($, reviewing)) && !waits))) {
      await finishReview($, e.answer, e.reason)
    }
    // 기획이 모두 끝났으면(단계가 모두 완료, 릴레이 행이 모두 통과) 목록을 비운다. 개발 화면도 공유 파일로 비워진다.
    if (mine === 'plan' && !waits && isAllDone(await read($, todos), await read($, relay))) {
      await update($, todos, () => [])
      await update($, relay, () => [])
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mine = await read($, role)
    if (mine === null || e.props.hasSurvey) return next(e)

    // 메인이 쉬어도 메인이 띄운 에이전트가 일하면 일하는 중이다.
    // 작업 중일 때만 frame을 읽어 구독한다. 쉬는 동안에는 다시 그리지 않는다.
    const busy = e.props.isWorking || (await read($, agents)).length > 0
    const lines = artFor(mine, busy ? await read($, frame) : 0)
    const current = await read($, task)
    const label = `   ${roleLabel(mine)} ${busy ? '중' : '대기'}   `
    // 두 세션이 같은 목록을 그린다. 내 몫은 상태에서, 상대 몫은 2초마다 읽은 공유 파일에서 가져온다.
    // 이름표가 1줄을 쓰므로 목록은 maxRows - 1줄까지 그린다. band가 높아져도 목록을 자르지 않는 쪽을 택했다.
    // 긴 글은 접는다. 기호 칸은 줄어들지 않게 따로 두어 접힌 줄이 글 시작에 맞춰진다.
    // 상대가 일하는 중일 수 있어 쉬는 동안에도 목록은 흐리게 하지 않는다.
    // 긴 줄을 접으려고 터미널이 열을 줄여도 캐릭터와 이름표는 줄어들지 않게 한다.
    const own = await read($, todos)
    const other = await read($, partner)
    const list = todoLines(
      mine === 'plan' ? { todos: own, relay: await read($, relay) } : other,
      mine === 'dev' ? { todos: own, todoFor: await read($, todoFor) } : other,
      e.props.maxRows - 1,
    )
    // 요청을 보낸 뒤에는 그 요청의 모델과 effort를, 그 전에는 세션 모델만 캐릭터 발 밑에 작게 보인다.
    // shortcut: /model로 바꾼 모델은 다음 요청부터 보인다, 바로 보이게 하려면 모델 바뀜을 따로 읽는다.
    const used: MainModel = (await read($, mainModel)) ?? { model: await sessionModel($) }
    // 캐릭터 아래 한 줄이 더 든다. band가 캐릭터 줄 수만큼만 허용하면 그리지 않는다.
    const caption = used.model !== '' && e.props.maxRows > lines.length ? modelLine(used.model, used.effort) : ''
    // 캐릭터 칸이 한 줄 커진 만큼 이름표 칸도 한 줄 띄운다. 목록이 짧아도 이름표가 캐릭터와 같은 줄에 머문다.
    const spare = caption !== '' && list.length < lines.length ? 1 : 0
    // 데스크톱은 Text를 비례 글꼴로 그린다. 캐릭터와 모델 줄은 고정폭(mono)으로 그려야 줄이 맞고, 모델 줄은 작은 글자(caption)로 그린다.
    // 터미널은 mono와 size를 무시한다.
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center">
        <Box flexDirection="column" flexShrink={0}>
          {lines.map(line => (
            <Text color={ORANGE} dimColor={!busy} mono>
              {line}
            </Text>
          ))}
          {caption !== '' && (
            <Text dimColor mono size="caption">
              {caption}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" marginLeft={3} marginBottom={spare}>
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text bold dimColor={!busy} {...LABEL_STYLE[mine]}>
                {label}
              </Text>
            </Box>
            {busy && current !== null && (
              <Text dimColor wrap="truncate">
                {`  ${current.title}`}
              </Text>
            )}
          </Box>
          {list.map(line => (
            <Box flexDirection="row">
              {line.prefix !== '' && (
                <Box flexShrink={0}>
                  <Text dimColor={line.isDone}>{line.prefix}</Text>
                </Box>
              )}
              <Text bold={line.isHeader} dimColor={line.isDone} wrap="wrap">
                {line.text}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
