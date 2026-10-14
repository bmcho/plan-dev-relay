import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionSendResult,
  Timer,
  TurnCompleteReason,
} from 'claude-code'

import type { CommandRun, Review, Role, Task } from '../types'
import { artFor, LABEL_STYLE, ORANGE } from './art'
import {
  baseName,
  buildReport,
  dayStamp,
  DEFAULT_LOG_ROOT,
  DEFAULT_REVIEW_ROUNDS,
  DEV_ALIAS,
  devGuide,
  entry,
  expandHome,
  firstLine,
  logPath,
  parseRelayArgs,
  parseRoles,
  parseTag,
  planGuide,
  RELAY_USAGE,
  REPORT_LIMIT,
  reviewGuide,
  reviewHeader,
  reviewStatus,
  roleLabel,
  rolesPath,
  unwrap,
  withTag,
  type Roles,
  type Sender,
} from './core'

const P = 'plan-dev-relay'
export const role = atom({ plugin: 'plan-dev-relay', key: 'role' } as const, null)
// 이 repo의 로그 폴더 (<logRoot>/<repo 이름>). /role 때 정한다.
export const dir = atom({ plugin: 'plan-dev-relay', key: 'dir' } as const, '')
export const frame = atom({ plugin: 'plan-dev-relay', key: 'frame' } as const, 0)
export const task = atom({ plugin: 'plan-dev-relay', key: 'task' } as const, null)
export const edits = atom({ plugin: 'plan-dev-relay', key: 'edits' } as const, [])
export const commands = atom({ plugin: 'plan-dev-relay', key: 'commands' } as const, [])
export const reports = atom({ plugin: 'plan-dev-relay', key: 'reports' } as const, [])
export const review = atom({ plugin: 'plan-dev-relay', key: 'review' } as const, {
  mode: 'manual',
  max: DEFAULT_REVIEW_ROUNDS,
  rounds: 0,
})

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

// 다른 세션이 같은 역할로 다시 등록했으면 그 항목은 남긴다.
const clearRole = async ($: EngineInterface, logDir: string, mine: Role, sessionId: string) => {
  const roles = await readRoles($, logDir)
  if (roles[mine]?.sessionId !== sessionId) return
  delete roles[mine]
  await $.fs.write(rolesPath(logDir), `${JSON.stringify(roles, null, 2)}\n`)
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

const startTask = async ($: EngineInterface, next: Task) => {
  const current = await read($, task)
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

const USAGE = '사용법: /role plan | dev | off'

export const register: Register = (on, options) => {
  // hot reload 때 module 변수는 초기화된다. 다음 turn.start에서 다시 켠다.
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'role', description: `plan-dev-relay 역할 지정. ${USAGE}` })
    await $.command.register({
      name: 'relay',
      description: `plan-dev-relay 보고 검토 방식 (수동/자동). ${RELAY_USAGE}`,
    })
    return next(e)
  })

  on('command.run', { command: 'role' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === '') {
      const mine = await read($, role)
      if (mine === null) return { text: `역할 없음. ${USAGE}` }
      const roles = await readRoles($, await read($, dir))
      const partner = mine === 'plan' ? roles.dev : roles.plan
      return {
        text: `${roleLabel(mine)} 역할. 상대 세션: ${partner?.sessionId ?? '없음'}`,
      }
    }

    if (arg === 'off') {
      timer?.cancel()
      timer = undefined
      const mine = await read($, role)
      if (mine !== null) await clearRole($, await read($, dir), mine, await $.session.id())
      await update($, role, () => null)
      return { text: '역할을 지웠습니다.' }
    }

    if (arg !== 'plan' && arg !== 'dev') return { text: USAGE }

    const next: Role = arg
    const name = await repoName($)
    const configured =
      typeof options.logRoot === 'string' && options.logRoot !== '' ? options.logRoot : DEFAULT_LOG_ROOT
    const root = expandHome(configured, (await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
    const logDir = `${root}/${name}`
    const sessionId = await $.session.id()
    await writeRole($, logDir, next, sessionId, await $.clock.now())
    await update($, dir, () => logDir)
    await update($, role, () => next)
    await log($, `[${roleLabel(next)}] 역할 등록`, `session: ${sessionId}`)
    // 시스템 프롬프트는 세션 시작 때 그려지므로, 역할 안내는 명령 결과의 context로 모델에 넘긴다.
    return {
      text: `${roleLabel(next)} 역할로 등록했습니다. (repo: ${name})`,
      context: [next === 'plan' ? planGuide() : devGuide()],
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
      parsed.mode === 'auto'
        ? { mode: 'auto', max: parsed.max, rounds: 0 }
        : { mode: 'manual', max: current.max, rounds: 0 }
    await update($, review, () => next)
    await log($, '[기획] 검토 모드 변경', reviewStatus(next))
    return { text: reviewStatus(next), context: [reviewGuide(next)] }
  })

  on('session.receive', async ($, e, next) => {
    const mine = await read($, role)
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (mine === null || !isPeer) return next(e)
    const { sender, body } = parseTag(e.text)
    if (sender === null || !(await partnerOf($, sender))) return next(e)
    const route = `(${sender.sessionId} → ${await $.session.id()})`

    if (mine === 'plan') {
      const current = await read($, review)
      await log($, `[기획] 보고 수신 ${route}`, unwrap(body))

      if (current.mode === 'auto' && current.rounds < current.max) {
        // 자동 검토: 머리말을 붙여 넘기면 엔진이 기획 세션의 turn을 시작한다.
        const round = current.rounds + 1
        await update($, review, r => ({ ...r, rounds: r.rounds + 1 }))
        await $.ui.toast(`개발 보고 도착: ${firstLine(body)} (자동 검토 ${round}/${current.max})`)
        await log($, `[기획] 자동 검토 ${round}/${current.max}`, firstLine(body))
        return next({ ...e, text: `${reviewHeader(round, current.max)}\n${body}` })
      }

      // 수동이거나 자동 검토 한도에 닿았으면 다음 사용자 프롬프트의 context로 넘긴다.
      await update($, reports, list => [...list, body])
      if (current.mode === 'auto') {
        await $.ui.toast(`자동 검토 ${current.max}회 도달, 확인이 필요합니다: ${firstLine(body)}`)
        await log($, '[기획] 자동 검토 한도 도달', `${current.max}회. 다음 사용자 프롬프트와 함께 전달한다.`)
      } else {
        await $.ui.toast(`개발 보고 도착: ${firstLine(body)}`)
      }
      return { consumed: 'plan-dev-relay: 기획 세션은 짝의 보고를 기록만 한다' }
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
    const text =
      mine === 'dev'
        ? devGuide()
        : current.mode === 'auto'
          ? `${planGuide()}\n\n${reviewGuide(current)}`
          : planGuide()
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
    if (e.to !== DEV_ALIAS && e.to !== devId) return next({ ...e, text })

    if (devId === undefined) {
      const reason = '등록된 개발 세션 없음. 사용자에게 다른 세션에서 /role dev 입력을 요청한다.'
      await $.ui.toast(`개발 세션 전달 실패: ${reason}`)
      await log($, '[기획] 전달 실패', reason)
      return { isDelivered: false, reason }
    }

    // SendMessage는 세션 id를 주소로 받지 않으므로 짝인 개발 세션에는 mod가 직접 보낸다.
    await log($, `[기획→개발] 지시 (${myId} → ${devId})`, parseTag(e.text).body)
    const sent = await sendSafely($, devId, text)
    if (!sent.isDelivered) {
      await $.ui.toast(`개발 세션 전달 실패: ${sent.reason}`)
      await log($, '[기획] 전달 실패', sent.reason)
    }
    return sent
  })

  on('prompt.submit', async ($, e, next) => {
    const mine = await read($, role)
    // 터미널 입력(composer)과 Remote Control 입력(bridge) 모두 사용자 본인의 프롬프트다.
    const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (mine === null || !isUser) return next(e)

    if (mine === 'dev') {
      await startTask($, { source: 'direct', title: firstLine(e.text), prompt: e.text })
      await log($, '[개발] 직접 입력', e.text)
      return next(e)
    }

    // 사용자가 직접 입력하면 자동 검토 횟수를 처음부터 다시 센다.
    await update($, review, r => (r.rounds === 0 ? r : { ...r, rounds: 0 }))
    const pending = await read($, reports)
    if (pending.length === 0) return next(e)
    const context = pending.map(report => `[plan-dev-relay] 개발 세션 보고:\n${report}`)
    const submitted = await next({ ...e, context: [...(e.context ?? []), ...context] })
    // 프롬프트가 거부되면 보고를 다음 프롬프트까지 남긴다.
    if (submitted.drop === undefined) {
      await update($, reports, list => list.slice(pending.length))
    }
    return submitted
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((await read($, role)) !== 'dev' || (await read($, task)) === null) return ran
    const isOk = ran.deny === undefined && ran.isError !== true

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
  })

  on('turn.start', async ($, e, next) => {
    if ((await read($, role)) !== null) {
      timer?.cancel()
      timer = $.clock.every(200, () => void update($, frame, n => (n + 1) % 600))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    timer?.cancel()
    timer = undefined
    if ((await read($, role)) === 'dev') await finishTask($, e.answer, e.reason)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mine = await read($, role)
    if (mine === null || e.props.hasSurvey) return next(e)

    // 작업 중일 때만 frame을 읽어 구독한다. 쉬는 동안에는 다시 그리지 않는다.
    const busy = e.props.isWorking
    const lines = artFor(mine, busy ? await read($, frame) : 0)
    const current = await read($, task)
    const label = `   ${roleLabel(mine)} ${busy ? '중' : '대기'}   `
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center">
        <Box flexDirection="column">
          {lines.map(line => (
            <Text color={ORANGE} dimColor={!busy}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" marginLeft={3}>
          <Text bold dimColor={!busy} {...LABEL_STYLE[mine]}>
            {label}
          </Text>
          {busy && current !== null && (
            <Text dimColor wrap="truncate">
              {`  ${current.title}`}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
