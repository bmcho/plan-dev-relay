import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const ROOT = '/Users/bmcho/Documents/claude/plan-dev-log/control-center'
const ROLES = `${ROOT}/roles.json`
const LOG = `${ROOT}/2026-10-14.md`
const TODO_PLAN = `${ROOT}/todo-plan.json`
const TODO_DEV = `${ROOT}/todo-dev.json`
// 2026-10-14 08:30:00 KST
const NOW = Date.UTC(2026, 9, 13, 23, 30, 0)

type World = {
  files: Map<string, string>
  sends: { to: string; text: string }[]
  toasts: string[]
  uiLogs: string[]
  // 전송 실패를 흉내 낸다: refuse는 isDelivered false, sendThrows는 예외.
  refuse?: string
  sendThrows?: boolean
  // $.agent.list()의 답. 백그라운드 에이전트를 흉내 낸다.
  agents?: AgentInfo[]
  // 이 경로에 쓰기를 실패시킨다.
  failWrite?: string
}

// 엔진 바닥을 흉내 낸다. 테스트의 on() hook은 plugin 아래에 놓인다.
// $ 호출 이벤트(session.id, fs.*, process.run, ui.toast ...)의 답은 { value }로 감싼다.
const engine = (on: On, sessionId: string, world: World) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/bmcho' })
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({
    value: { root: '/Users/bmcho/Documents/git/control-center', remote: null, internal: false } as never,
  }))
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  // 실제 엔진처럼 없는 파일 읽기는 예외로 끝난다.
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (e.path === world.failWrite) throw new Error(`EACCES: ${e.path}`)
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  // register.tsx의 /bin/sh 스크립트와 같은 효과: 새 파일이면 제목을 쓰고 stdin을 덧붙인다.
  on('process.run', ($, e) => {
    const [, , , , path = '', repo = '', day = ''] = e.argv
    const before = world.files.get(path) ?? `# ${repo} plan-dev log ${day}\n`
    world.files.set(path, before + (e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('session.send', ($, e) => {
    if (world.sendThrows === true) throw new Error('socket closed')
    if (world.refuse !== undefined) return { isDelivered: false, reason: world.refuse }
    world.sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('ui.log', ($, e) => {
    world.uiLogs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: {} as never }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // TaskCreate는 실제 세션처럼 id를 1부터 차례로 준다.
  let taskId = 0
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') {
      taskId += 1
      return { result: { task: { id: String(taskId), subject: e.subject } }, isError: false, text: 'ok' } as never
    }
    if (e.tool === 'TaskUpdate') {
      return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] }, isError: false, text: 'ok' } as never
    }
    return { result: {}, isError: false, text: 'ok' } as never
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('agent.list', () => ({ value: world.agents ?? [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return clock
}

const newWorld = (): World => ({ files: new Map(), sends: [], toasts: [], uiLogs: [] })

const tag = (role: 'plan' | 'dev', sessionId: string, text: string) =>
  `[plan-dev-relay role=${role} session=${sessionId}]\n${text}`

// 엔진이 다른 세션의 메시지를 감싸는 형식 (실제 로그에서 가져옴)
const wrap = (text: string) =>
  `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="control-center-1" from-mode="prompting">\n${text}\n</cross-session-message>`

test('/role dev records the session in roles.json and the log', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-DEV', world)

  const result = await $.command.run({ command: 'role', args: 'dev' } as never)

  expect(result.text).toContain('개발')
  expect(JSON.parse(world.files.get(ROLES) ?? '{}').dev.sessionId).toBe('S-DEV')
  expect(world.files.get(LOG)).toContain('# control-center plan-dev log 2026-10-14')
  expect(world.files.get(LOG)).toContain('[개발] 역할 등록')
})

test('/role overwrites a broken roles.json', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, '{broken')
  engine(on, 'S-PLAN', world)

  await $.command.run({ command: 'role', args: 'plan' } as never)

  expect(JSON.parse(world.files.get(ROLES) ?? '{}').plan.sessionId).toBe('S-PLAN')
  expect(world.uiLogs.join('\n')).toContain('roles.json')
})

test('/role rejects an unknown argument', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-X', world)

  const result = await $.command.run({ command: 'role', args: 'boss' } as never)

  expect(result.text).toContain('사용법')
  expect(world.files.size).toBe(0)
})

test('a session without a role passes peer messages through and writes nothing', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-X', world)

  const result = await $.session.receive({ origin: { kind: 'peer' }, text: '작업' } as never)

  expect(result.text).toBe('작업')
  expect(world.files.size).toBe(0)
  expect(world.sends).toHaveLength(0)
})

const setRoles = (world: World) =>
  world.files.set(ROLES, JSON.stringify({ plan: { sessionId: 'S-PLAN', updatedAt: 't' } }))

const devTurn = async ($: Engine, answer: string, reason: 'answer' | 'aborted' | 'error' = 'answer') => {
  await $.turn.start({ text: '', turnId: 'T1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'acs/Foo.java', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: './gradlew test' } as never)
  await $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: 'T1',
    reason,
  } as never)
}

test('dev reports a planned task to the plan session with its tag', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  const received = await $.session.receive({
    origin: { kind: 'peer' },
    text: tag('plan', 'S-PLAN', 'TMS 경로 API 추가\n상세'),
  } as never)
  await devTurn($, '완료했습니다.')

  expect(received.text).toBe('TMS 경로 API 추가\n상세')
  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.to).toContain('S-PLAN')
  expect(world.sends[0]?.text.startsWith('[plan-dev-relay role=dev session=S-DEV]\n')).toBe(true)
  expect(world.sends[0]?.text).toContain('[개발 보고] TMS 경로 API 추가')
  expect(world.sends[0]?.text).toContain('검수 기준 (원래 지시):\nTMS 경로 API 추가\n상세')
  expect(world.sends[0]?.text).toContain('- acs/Foo.java')
  expect(world.sends[0]?.text).toContain('- 성공: ./gradlew test')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[개발] 수신 (S-PLAN → S-DEV)')
  expect(log).toContain('[개발] 파일 수정')
  expect(log).toContain('[개발] 명령 성공')
  expect(log).toContain('[개발→기획] 보고 (S-DEV → S-PLAN)')
})

test('dev cuts a long answer in the report but logs it whole', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '긴 작업') } as never)
  await devTurn($, 'z'.repeat(9000))

  expect(world.sends[0]?.text).not.toContain('z'.repeat(8001))
  expect(world.sends[0]?.text).toContain(`전체 내용: ${LOG}`)
  expect(world.files.get(LOG)).toContain('z'.repeat(9000))
})

test('dev keeps the running task when a second instruction arrives', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '첫 작업') } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '둘째 작업') } as never)
  await devTurn($, 'done')

  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.text).toContain('[개발 보고] 첫 작업')
  expect(world.sends[0]?.text).toContain('추가로 받은 지시:\n- 둘째 작업')
  expect(world.files.get(LOG)).toContain('둘째 작업')
})

test('dev marks an interrupted task', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)
  await devTurn($, '일부만', 'aborted')

  expect(world.sends[0]?.text).toContain('(중단됨)')
})

test('dev toasts and logs a failed delivery when the plan session is gone', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)
  const roles = JSON.parse(world.files.get(ROLES) ?? '{}')
  delete roles.plan
  world.files.set(ROLES, JSON.stringify(roles))
  await devTurn($, 'done')

  expect(world.sends).toHaveLength(0)
  expect(world.toasts.join('\n')).toContain('전달 실패')
  expect(world.files.get(LOG)).toContain('[개발] 전달 실패')
})

test('dev does not treat untagged or stranger messages as tasks', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  const untagged = await $.session.receive({ origin: { kind: 'peer' }, text: '안녕' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-OTHER', '남의 지시') } as never)
  await devTurn($, 'done')

  expect(untagged.text).toBe('안녕')
  expect(world.sends).toHaveLength(0)
  expect(world.files.get(LOG) ?? '').not.toContain('[개발] 수신')
})

test('dev tags messages its model sends with SendMessage', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  // 모델의 SendMessage는 주소를 문자열로 넘긴다.
  await $.session.send({ to: 'S-PLAN', text: '질문 있어요', origin: { kind: 'model' } })

  expect(world.sends[0]?.text).toBe('[plan-dev-relay role=dev session=S-DEV]\n질문 있어요')
})

test('dev logs direct input without reporting it', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.prompt.submit({ text: '직접 고쳐 줘', wait: false, origin: { kind: 'composer' } } as never)
  await devTurn($, '고쳤습니다.')

  expect(world.sends).toHaveLength(0)
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[개발] 직접 입력')
  expect(log).toContain('[개발] 파일 수정')
  expect(log).toContain('[개발] 직접 작업 완료')
  expect(log).toContain('고쳤습니다.')
})

test("plan sends its dev partner's report to the model for inspection, even in manual mode", async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  const fromPartner = await $.session.receive({
    origin: { kind: 'peer', plugin: 'plan-dev-relay' },
    text: tag('dev', 'S-DEV', '[개발 보고] 경로 API'),
  } as never)
  const fromStranger = await $.session.receive({ origin: { kind: 'peer' }, text: '다른 세션 메시지' } as never)

  expect(fromPartner.consumed).toBeUndefined()
  expect(fromPartner.text?.startsWith('[plan-dev-relay 검수 요청]')).toBe(true)
  expect(fromPartner.text).toContain('다시 지시하지 않는다')
  expect(fromPartner.text).toContain('[개발 보고] 경로 API')
  expect(fromPartner.text).not.toContain('plan-dev-relay role=')
  expect(fromStranger.text).toBe('다른 세션 메시지')
  expect(world.toasts.join('\n')).toContain('개발 보고 도착: [개발 보고] 경로 API (검수 시작)')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[기획] 보고 수신 (S-DEV → S-PLAN)')
  expect(log).toContain('[기획] 검수 요청')
})

test('plan tags and logs instructions it sends', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  await $.session.send({ to: 'S-DEV', text: '경로 API 추가', origin: { kind: 'model' } })

  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.text).toBe('[plan-dev-relay role=plan session=S-PLAN]\n경로 API 추가')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[기획→개발] 지시 (S-PLAN → S-DEV)')
  expect(log).toContain('경로 API 추가')
  expect(log).not.toContain('plan-dev-relay role=')
})

test('plan adds the dev-session guide to the system prompt', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  const composed = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  } as never)

  const guide = composed.sections.find(section => section.id === 'plan-dev-relay:guide')
  expect(guide?.text).toContain('to에는 "dev-session"')
  expect(guide?.scope).toBe('session')
  expect(composed.sections[0]?.id).toBe('intro')
})

const BAND = {
  plugin: 'plan-dev-relay',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('band shows the role label while idle and working', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', 'TMS 경로 API 추가') } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    // Text는 key를 갖지 않으므로 표시된 글자로 찾는다.
    const idle = await $.ui.mount({ ...BAND, surface })
    expect(await idle.find({ type: 'Text', text: /개발 대기/ })).toBeDefined()
    expect(await idle.find({ type: 'Text', text: /TMS 경로 API 추가/ })).toBeUndefined()
    await idle.unmount()

    const busy = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, isWorking: true } })
    expect(await busy.find({ type: 'Text', text: /개발 중/ })).toBeDefined()
    expect(await busy.find({ type: 'Text', text: /TMS 경로 API 추가/ })).toBeDefined()
    await busy.unmount()
  }
})

test('plan routes SendMessage to "dev-session" through the mod to the dev session', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  const sent = await $.session.send({ to: 'dev-session', text: '경로 API 추가', origin: { kind: 'model' } })

  expect(sent.isDelivered).toBe(true)
  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.to).toContain('S-DEV')
  expect(world.sends[0]?.text).toBe('[plan-dev-relay role=plan session=S-PLAN]\n경로 API 추가')
  expect(world.files.get(LOG)).toContain('[기획→개발] 지시 (S-PLAN → S-DEV)')
})

test('plan refuses an instruction when no dev session is registered', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  const sent = await $.session.send({ to: 'dev-session', text: '경로 API 추가', origin: { kind: 'model' } })

  expect(sent.isDelivered).toBe(false)
  expect(sent.reason).toContain('/role dev')
  expect(world.sends).toHaveLength(0)
  expect(world.toasts.join('\n')).toContain('개발 세션 전달 실패')
  expect(world.files.get(LOG)).toContain('[기획] 전달 실패')
})

test('plan tags but does not log as instructions messages to other recipients', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  await $.session.send({ to: 'helper', text: '조사해 줘', origin: { kind: 'model' } })

  expect(world.sends[0]?.to).toBe('helper')
  expect(world.sends[0]?.text).toBe('[plan-dev-relay role=plan session=S-PLAN]\n조사해 줘')
  expect(world.files.get(LOG) ?? '').not.toContain('[기획→개발] 지시')
})

test('dev accepts instructions delivered as peer-send-message', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  const received = await $.session.receive({
    origin: { kind: 'peer-send-message' },
    text: tag('plan', 'S-PLAN', '경로 API 추가'),
  } as never)
  await devTurn($, 'done')

  expect(received.text).toBe('경로 API 추가')
  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.text).toContain('[개발 보고] 경로 API 추가')
})

test('dev reports a planned task that arrives during a direct task, keeping earlier records', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.prompt.submit({ text: '직접 고쳐 줘', wait: false, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'acs/Early.java', old_string: 'a', new_string: 'b' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', 'TMS 경로 API') } as never)
  await devTurn($, 'done')

  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.text).toContain('[개발 보고] TMS 경로 API')
  expect(world.sends[0]?.text).toContain('- acs/Early.java')
  expect(world.sends[0]?.text).toContain('- acs/Foo.java')
})

test('dev marks a turn that ended on an error', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)
  await devTurn($, '', 'error')

  expect(world.sends[0]?.text).toContain('(오류로 종료)')
})

test("/role off removes only this session's own entry from roles.json", async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)

  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.command.run({ command: 'role', args: 'off' } as never)
  const afterOff = JSON.parse(world.files.get(ROLES) ?? '{}')
  expect(afterOff.dev).toBeUndefined()
  expect(afterOff.plan.sessionId).toBe('S-PLAN')

  await $.command.run({ command: 'role', args: 'dev' } as never)
  const taken = JSON.parse(world.files.get(ROLES) ?? '{}')
  taken.dev = { sessionId: 'S-NEW', updatedAt: 't' }
  world.files.set(ROLES, JSON.stringify(taken))
  await $.command.run({ command: 'role', args: 'off' } as never)
  expect(JSON.parse(world.files.get(ROLES) ?? '{}').dev.sessionId).toBe('S-NEW')
})

test('/role hands the role guide to the model through the command context', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-PLAN', world)

  const plan = await $.command.run({ command: 'role', args: 'plan' } as never)
  const dev = await $.command.run({ command: 'role', args: 'dev' } as never)

  expect((plan.context ?? []).join('\n')).toContain('to에는 "dev-session"')
  expect((dev.context ?? []).join('\n')).toContain('# plan-dev-relay: 개발 역할')
})

test('dev titles and logs a wrapped instruction without the engine wrapper, but keeps it for the model', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  const received = await $.session.receive({
    origin: { kind: 'peer', plugin: 'plan-dev-relay' },
    text: wrap(tag('plan', 'S-PLAN', 'TMS 경로 API 추가\n상세')),
  } as never)
  await devTurn($, 'done')

  expect(received.text).toContain('<cross-session-message')
  expect(received.text).not.toContain('plan-dev-relay role=')
  expect(world.sends[0]?.text).toContain('[개발 보고] TMS 경로 API 추가\n')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('TMS 경로 API 추가\n상세')
  expect(log).not.toContain('cross-session-message')
})

test('plan toasts and logs a wrapped report without the engine wrapper', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  await $.session.receive({
    origin: { kind: 'peer', plugin: 'plan-dev-relay' },
    text: wrap(tag('dev', 'S-DEV', '[개발 보고] 경로 API\n완료')),
  } as never)

  expect(world.toasts.join('\n')).toContain('개발 보고 도착: [개발 보고] 경로 API')
  expect(world.files.get(LOG) ?? '').not.toContain('cross-session-message')
})

test('dev toasts and logs when the plan session refuses the report', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)
  world.refuse = '수신 세션 종료'
  await devTurn($, 'done')

  expect(world.toasts.join('\n')).toContain('기획 세션 전달 실패: 수신 세션 종료')
  expect(world.files.get(LOG)).toContain('[개발] 전달 실패')
})

test('dev toasts and logs when sending the report throws', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)
  world.sendThrows = true
  await devTurn($, 'done')

  expect(world.toasts.join('\n')).toContain('기획 세션 전달 실패')
  expect(world.files.get(LOG)).toContain('[개발] 전달 실패')
})

test('plan refuses with a reason when sending the instruction throws', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  world.sendThrows = true
  const sent = await $.session.send({ to: 'dev-session', text: '경로 API 추가', origin: { kind: 'model' } })

  expect(sent.isDelivered).toBe(false)
  expect(world.toasts.join('\n')).toContain('개발 세션 전달 실패')
  expect(world.files.get(LOG)).toContain('[기획] 전달 실패')
})

test('/role writes roles.json and the log under the logRoot option', { options: { logRoot: '/var/plan-logs' } }, async ($, on) => {
  const world = newWorld()
  engine(on, 'S-DEV', world)

  await $.command.run({ command: 'role', args: 'dev' } as never)

  expect(JSON.parse(world.files.get('/var/plan-logs/control-center/roles.json') ?? '{}').dev.sessionId).toBe('S-DEV')
  expect(world.files.get('/var/plan-logs/control-center/2026-10-14.md')).toContain('# control-center plan-dev log 2026-10-14')
  expect(world.files.has(ROLES)).toBe(false)
})

// 진행 모드 (/relay)
const planWithDev = async ($: Engine, on: On, world: World) => {
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  const clock = engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)
  return clock
}

const report = (text: string) =>
  ({ origin: { kind: 'peer', plugin: 'plan-dev-relay' }, text: wrap(tag('dev', 'S-DEV', text)) }) as never

const userPrompt = (text: string) =>
  ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('/relay auto 2 switches the plan session to automatic review and /relay shows it', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)

  const switched = await $.command.run({ command: 'relay', args: 'auto 2' } as never)
  const status = await $.command.run({ command: 'relay', args: '' } as never)

  expect(switched.text).toContain('오토')
  expect(switched.text).toContain('최대 2회')
  expect((switched.context ?? []).join('\n')).toContain('모드: 오토')
  expect(status.text).toContain('오토')
  expect(world.files.get(LOG)).toContain('[기획] 릴레이 모드 변경')
})

test('auto mode lets the plan re-instruct up to the limit, then still asks for an inspection', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.command.run({ command: 'relay', args: 'auto 2' } as never)

  const first = await $.session.receive(report('[개발 보고] 1차\n본문1'))
  const second = await $.session.receive(report('[개발 보고] 2차\n본문2'))
  const third = await $.session.receive(report('[개발 보고] 3차\n본문3'))

  expect(first.consumed).toBeUndefined()
  expect(first.text?.startsWith('[plan-dev-relay 검수 요청 오토 1/2]')).toBe(true)
  expect(first.text).toContain('[개발 보고] 1차\n본문1')
  expect(second.text?.startsWith('[plan-dev-relay 검수 요청 오토 2/2]')).toBe(true)
  expect(third.consumed).toBeUndefined()
  expect(third.text?.startsWith('[plan-dev-relay 검수 요청]')).toBe(true)
  expect(third.text).toContain('다시 지시하지 않는다')
  expect(world.toasts.join('\n')).toContain('오토 한도 2회 도달')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[기획] 검수 요청 (오토 1/2)')
  expect(log).toContain('[기획] 검수 요청 (오토 2/2)')
  expect(log).toContain('[기획] 검수 요청 (오토 한도 2회 도달)')
})

test('a user prompt resets the automatic review count', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.command.run({ command: 'relay', args: 'auto 1' } as never)

  await $.session.receive(report('[개발 보고] 1차'))
  await $.prompt.submit(userPrompt('다음 작업 지시해'))
  const after = await $.session.receive(report('[개발 보고] 2차'))

  expect(after.consumed).toBeUndefined()
  expect(after.text?.startsWith('[plan-dev-relay 검수 요청 오토 1/1]')).toBe(true)
})

test('/relay manual stops automatic re-instruction but keeps the inspection', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.command.run({ command: 'relay', args: 'auto' } as never)
  await $.command.run({ command: 'relay', args: 'manual' } as never)

  const received = await $.session.receive(report('[개발 보고] 수동'))

  expect(received.consumed).toBeUndefined()
  expect(received.text?.startsWith('[plan-dev-relay 검수 요청]')).toBe(true)
  expect(received.text).toContain('다시 지시하지 않는다')
  expect(world.toasts.join('\n')).toContain('개발 보고 도착: [개발 보고] 수동 (검수 시작)')
})

test('/relay refuses to switch outside a plan session and rejects bad arguments', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  const refused = await $.command.run({ command: 'relay', args: 'auto' } as never)
  const bad = await $.command.run({ command: 'relay', args: 'auto 0' } as never)
  const tooMany = await $.command.run({ command: 'relay', args: 'full 51' } as never)

  expect(refused.text).toContain('기획 세션에서만')
  expect(bad.text).toContain('사용법: /relay')
  expect(tooMany.text).toContain('사용법: /relay')
})

// 검수 보고서: 검수 요청이 들어간 turn의 마지막 답변
const inspectionTurn = async ($: Engine, request: string, answer: string, reason: 'answer' | 'aborted' = 'answer') => {
  await $.prompt.submit({ text: request, wait: false, origin: { kind: 'peer' } } as never)
  await $.turn.start({ text: '', turnId: 'P1' } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 'P1', reason } as never)
}

const ordinaryTurn = async ($: Engine, answer: string) => {
  await $.turn.start({ text: '', turnId: 'P2' } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'P2', reason: 'answer' } as never)
}

test('plan logs the inspection report once, when the inspection turn ends', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  const received = await $.session.receive(report('[개발 보고] 경로 API'))

  const answer = '[검수 보고] 경로 API\n검수 결과: 반려 — 테스트 없음\n문제와 고칠 점: 테스트 추가'
  await inspectionTurn($, received.text ?? '', answer)
  await $.prompt.submit(userPrompt('고마워'))
  await ordinaryTurn($, '네.')

  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[기획] 검수 보고 (반려)')
  expect(log).toContain('문제와 고칠 점: 테스트 추가')
  expect(log.split('[기획] 검수 보고').length - 1).toBe(1)
  expect(world.toasts.join('\n')).toContain('검수 반려: [검수 보고] 경로 API')
})

test('plan warns when the inspection turn ends without a verdict', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  const received = await $.session.receive(report('[개발 보고] 경로 API'))

  await inspectionTurn($, received.text ?? '', '확인했습니다.', 'aborted')

  expect(world.files.get(LOG)).toContain('[기획] 검수 보고 누락 (중단됨)')
  expect(world.toasts.join('\n')).toContain('검수 보고서 누락')
})

test('plan does not treat an ordinary turn or a stranger message as an inspection', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)

  await $.prompt.submit(userPrompt('다음 작업 정리해 줘'))
  await ordinaryTurn($, '정리했습니다.')
  await $.prompt.submit({ text: '다른 세션 메시지', wait: false, origin: { kind: 'peer' } } as never)
  await ordinaryTurn($, '읽었습니다.')

  expect(world.files.get(LOG) ?? '').not.toContain('검수 보고')
  expect(world.toasts.join('\n')).not.toContain('검수')
})

test('plan also logs an inspection report the user asked for', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)

  await $.prompt.submit(userPrompt('방금 작업 다시 검수해 줘'))
  await ordinaryTurn($, '[검수 보고] 경로 API\n**검수 결과:** 통과')

  expect(world.files.get(LOG)).toContain('[기획] 검수 보고 (통과)')
})

test('/relay full switches to full auto with a default limit of 20', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)

  const switched = await $.command.run({ command: 'relay', args: 'full' } as never)

  expect(switched.text).toContain('풀오토')
  expect(switched.text).toContain('최대 20회')
  expect((switched.context ?? []).join('\n')).toContain('사용자 승인 없이')
  expect(world.files.get(LOG)).toContain('[기획] 릴레이 모드 변경')
})

test('full auto asks the plan to move on after each report, then only inspects past the limit', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.command.run({ command: 'relay', args: 'full 2' } as never)

  const first = await $.session.receive(report('[개발 보고] 1차'))
  await $.session.receive(report('[개발 보고] 2차'))
  const third = await $.session.receive(report('[개발 보고] 3차'))

  expect(first.text?.startsWith('[plan-dev-relay 검수 요청 풀오토 1/2]')).toBe(true)
  expect(first.text).toContain('다음 작업을 정해')
  expect(third.text?.startsWith('[plan-dev-relay 검수 요청]')).toBe(true)
  expect(third.text).toContain('다시 지시하지 않는다')
  expect(world.toasts.join('\n')).toContain('풀오토 한도 2회 도달')
  const log = world.files.get(LOG) ?? ''
  expect(log).toContain('[기획] 검수 요청 (풀오토 1/2)')
  expect(log).toContain('[기획] 검수 요청 (풀오토 한도 2회 도달)')
})

test('plan flags an inspection that stopped for the user', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.command.run({ command: 'relay', args: 'full' } as never)
  const received = await $.session.receive(report('[개발 보고] 배포 준비'))

  const answer =
    '[검수 보고] 배포 준비\n검수 결과: 통과\n다음 지시: 없음\n사용자 확인 필요: 운영 배포는 사용자 승인이 필요하다'
  await inspectionTurn($, received.text ?? '', answer)

  expect(world.files.get(LOG)).toContain('[기획] 사용자 확인 필요')
  expect(world.toasts.join('\n')).toContain('사용자 확인 필요: 운영 배포는 사용자 승인이 필요하다')
})

const agent = (id: string, status: AgentInfo['status'], more: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  status,
  description: '조사',
  type: 'general-purpose',
  ...more,
})

// 에이전트 loop의 turn. 엔진은 agentId를 붙여 알린다.
const agentStart = ($: Engine, agentId: string) =>
  $.turn.start({ text: '', turnId: `A-${agentId}`, agentId } as never)

const agentEnd = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `A-${agentId}`, agentId, reason: 'answer' } as never)

test('band stays busy and keeps moving while a background agent works after the main turn ended', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)

  // 메인 turn이 에이전트를 백그라운드로 띄우고 먼저 끝난다.
  await $.turn.start({ text: '', turnId: 'M1' } as never)
  world.agents = [agent('A1', 'running')]
  await agentStart($, 'A1')
  await $.turn.complete({ answer: '맡겼습니다.', durationMs: 1, isAborted: false, turnId: 'M1', reason: 'answer' } as never)

  // 메인은 쉬지만(isWorking false) 에이전트가 일하므로 '중'이고 캐릭터도 움직인다.
  await clock.advance(400)
  const working = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await working.find({ type: 'Text', text: /기획 중/ })).toBeDefined()
  expect(await working.find({ type: 'Text', text: /oO\( … \)/ })).toBeDefined()
  await working.unmount()

  // 막 끝난 에이전트는 목록의 상태가 늦게 바뀌어도 끝난 것으로 본다.
  await agentEnd($, 'A1')
  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: /기획 대기/ })).toBeDefined()
  await idle.unmount()
})

test('dev holds the report while a background agent works and sends it when the main loop ends after it', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '경로 API 추가') } as never)

  // 에이전트가 아직 시작 전(pending)이어도 메인 turn이 끝날 때 보고하지 않는다.
  await $.turn.start({ text: '', turnId: 'M1' } as never)
  world.agents = [agent('A1', 'pending')]
  await $.turn.complete({ answer: '맡겼습니다.', durationMs: 1, isAborted: false, turnId: 'M1', reason: 'answer' } as never)
  expect(world.sends).toHaveLength(0)

  // 에이전트가 고친 파일도 보고에 들어간다. 에이전트가 끝나도 메인이 마무리하기 전에는 보고하지 않는다.
  world.agents = [agent('A1', 'running')]
  await agentStart($, 'A1')
  await $.tool.call({ tool: 'Edit', file_path: 'acs/Bar.java', old_string: 'a', new_string: 'b', agentId: 'A1' } as never)
  world.agents = [agent('A1', 'completed')]
  await agentEnd($, 'A1')
  expect(world.sends).toHaveLength(0)

  // 엔진이 알림으로 메인을 깨우고, 그 turn이 끝날 때 보고한다.
  await devTurn($, '모두 끝났습니다.')
  expect(world.sends).toHaveLength(1)
  expect(world.sends[0]?.text).toContain('[개발 보고] 경로 API 추가')
  expect(world.sends[0]?.text).toContain('모두 끝났습니다.')
  expect(world.sends[0]?.text).toContain('- acs/Bar.java')
})

test('dev does not hold the report for loops that will not wake the main loop', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '작업') } as never)

  // 다른 plugin이 띄운 에이전트, 에이전트가 띄운 에이전트, 팀원, 목록에 없는 엔진의 fork
  world.agents = [
    agent('P1', 'running', { spawnedBy: 'other-plugin' }),
    agent('C1', 'running', { parentId: 'A0' }),
    agent('T1', 'running', { teammateId: 'reviewer@team' }),
  ]
  await agentStart($, 'F1')
  await devTurn($, '끝났습니다.')

  expect(world.sends).toHaveLength(1)
})

test('plan closes an inspection without a verdict only after its agents finish, but a verdict closes it at once', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  const first = await $.session.receive(report('[개발 보고] 경로 API'))

  // 검수를 에이전트에 맡기고 판정 없이 turn을 끝내면 아직 마무리하지 않는다.
  world.agents = [agent('A1', 'running')]
  await inspectionTurn($, first.text ?? '', '에이전트에 검수를 맡겼습니다.')
  expect(world.files.get(LOG)).not.toContain('[기획] 검수 보고')

  // 에이전트가 끝나고 메인이 판정을 쓰면 그때 마무리한다.
  world.agents = [agent('A1', 'completed')]
  await agentEnd($, 'A1')
  await ordinaryTurn($, '[검수 보고] 경로 API\n검수 결과: 통과')
  expect(world.files.get(LOG)).toContain('[기획] 검수 보고 (통과)')
  expect(world.files.get(LOG)).not.toContain('[기획] 검수 보고 누락')

  // 판정 줄이 있으면 에이전트가 일하는 중이어도 바로 마무리한다.
  const second = await $.session.receive(report('[개발 보고] 두 번째'))
  world.agents = [agent('A2', 'running')]
  await inspectionTurn($, second.text ?? '', '[검수 보고] 두 번째\n검수 결과: 반려 — 테스트 없음')
  expect(world.files.get(LOG)).toContain('[기획] 검수 보고 (반려)')
})

test('a reloaded session counts running agents again and keeps the character moving', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)

  // mod를 다시 불러오면 타이머는 사라지고 session.start가 다시 온다.
  world.agents = [agent('A1', 'running')]
  await $.session.start({ cwd: '/Users/bmcho/Documents/git/control-center', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(400)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /기획 중/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /oO\( … \)/ })).toBeDefined()
  await band.unmount()
})

// To-Do 공유: 2초마다 내 몫을 쓰고 상대 몫을 읽는다.
const shared = (world: World, path: string) => JSON.parse(world.files.get(path) ?? 'null')
const EMPTY_DEV = { sessionId: 'S-DEV', todos: [], relay: [], todoFor: null }

test('a session with a role writes its To-Do share every 2 seconds, only when it changed', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  expect(world.files.has(TODO_DEV)).toBe(false)
  await clock.advance(2000)
  expect(shared(world, TODO_DEV)).toEqual(EMPTY_DEV)
  // 짝(기획)이 아직 공유 파일을 쓰지 않았어도 알리지 않는다.
  expect(world.uiLogs).toEqual([])

  world.files.delete(TODO_DEV)
  await clock.advance(2000)
  expect(world.files.has(TODO_DEV)).toBe(false)
})

test('a broken roles.json does not repeat a notice every 2 seconds and the share is still written', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  world.files.set(ROLES, '{broken')

  await clock.advance(6000)

  expect(world.uiLogs).toEqual([])
  expect(shared(world, TODO_DEV)).toEqual(EMPTY_DEV)
})

test('session.start restarts sharing for a session that already has a role', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await clock.advance(2000)
  world.files.delete(TODO_DEV)

  // hot reload처럼 session.start가 다시 오면 기억을 비우고 처음부터 다시 쓴다.
  await $.session.start({
    cwd: '/Users/bmcho/Documents/git/control-center',
    surface: 'terminal',
    isInteractive: true,
  } as never)
  await clock.advance(2000)

  expect(shared(world, TODO_DEV)).toEqual(EMPTY_DEV)
})

test('/role off stops sharing and leaves an empty share', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await clock.advance(2000)
  world.files.delete(TODO_DEV)

  await $.command.run({ command: 'role', args: 'off' } as never)
  expect(shared(world, TODO_DEV)).toEqual(EMPTY_DEV)

  world.files.delete(TODO_DEV)
  await clock.advance(4000)
  expect(world.files.has(TODO_DEV)).toBe(false)
})

test('a failing share write is noticed once until a write works again', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  world.failWrite = TODO_DEV

  await clock.advance(6000)
  expect(world.uiLogs.filter(line => line.includes('To-Do 공유 파일 쓰기 실패'))).toHaveLength(1)

  world.failWrite = undefined
  await clock.advance(2000)
  expect(shared(world, TODO_DEV)).toEqual(EMPTY_DEV)
})

test('dev shares the Todos of a planned task and starts over on the next instruction', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '경로 API 추가\n상세') } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '테스트 작성', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '구현', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  // 작업 중에 온 추가 지시는 To-Do를 그대로 둔다.
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '추가 지시') } as never)
  await clock.advance(2000)
  expect(shared(world, TODO_DEV)).toEqual({
    sessionId: 'S-DEV',
    todos: [
      { id: '1', text: '테스트 작성', status: 'completed' },
      { id: '2', text: '구현', status: 'pending' },
    ],
    relay: [],
    todoFor: '경로 API 추가',
  })

  await devTurn($, 'done')
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '다음 작업') } as never)
  // 이전 지시의 id로 온 갱신은 비운 목록에 옛 항목을 되살리지 않는다.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' } as never)
  await clock.advance(2000)
  expect(shared(world, TODO_DEV).todos).toEqual([])
  expect(shared(world, TODO_DEV).todoFor).toBe('다음 작업')
})

test('dev keeps both of two task updates that run at the same time', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '경로 API') } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '설계', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '구현', description: 'd' } as never)

  // 한 답변 안의 병렬 도구 호출
  await Promise.all([
    $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never),
    $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never),
  ])
  await clock.advance(2000)

  expect(shared(world, TODO_DEV).todos).toEqual([
    { id: '1', text: '설계', status: 'completed' },
    { id: '2', text: '구현', status: 'in_progress' },
  ])
})

test('dev ignores Todos of direct work and of subagents, and starts them for an instruction that arrives during direct work', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)

  await $.prompt.submit(userPrompt('직접 고쳐 줘'))
  await $.tool.call({ tool: 'TaskCreate', subject: '직접 작업 단계', description: 'd' } as never)
  await clock.advance(2000)
  expect(shared(world, TODO_DEV).todos).toEqual([])

  // 직접 작업을 하는 중에 지시가 온다.
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '경로 API') } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '서브에이전트 단계', description: 'd', agentId: 'A1' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '지시 단계', description: 'd' } as never)
  await clock.advance(2000)

  // 테스트 엔진은 모든 TaskCreate에 id를 차례로 주므로 지시 단계의 id는 3이다.
  expect(shared(world, TODO_DEV)).toEqual({
    sessionId: 'S-DEV',
    todos: [{ id: '3', text: '지시 단계', status: 'pending' }],
    relay: [],
    todoFor: '경로 API',
  })
})

test('plan always shares the Todos its own agent keeps', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '요구 정리', status: 'completed', activeForm: '요구 정리 중' },
      { content: '계획 작성', status: 'in_progress', activeForm: '계획 작성 중' },
    ],
  } as never)
  await clock.advance(2000)

  expect(shared(world, TODO_PLAN).todos).toEqual([
    { text: '요구 정리', status: 'completed' },
    { text: '계획 작성', status: 'in_progress' },
  ])
})

test('plan shares its relay rows as the instruction is sent, reported and judged', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)

  await $.session.send({ to: 'dev-session', text: '경로 API 추가\n상세', origin: { kind: 'model' } })
  await clock.advance(2000)
  expect(shared(world, TODO_PLAN).relay).toEqual([{ title: '경로 API 추가', status: 'working' }])

  const received = await $.session.receive(report('[개발 보고] 경로 API 추가'))
  await clock.advance(2000)
  expect(shared(world, TODO_PLAN).relay).toEqual([{ title: '경로 API 추가', status: 'reviewing' }])

  await inspectionTurn($, received.text ?? '', '[검수 보고] 경로 API 추가\n검수 결과: 통과')
  await clock.advance(2000)
  expect(shared(world, TODO_PLAN)).toEqual({
    sessionId: 'S-PLAN',
    todos: [],
    relay: [{ title: '경로 API 추가', status: 'passed' }],
    todoFor: null,
  })
})

test('plan keeps a row in review without a verdict and adds no row for a refused instruction', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)
  await $.session.send({ to: 'dev-session', text: '1차', origin: { kind: 'model' } })
  const received = await $.session.receive(report('[개발 보고] 1차'))
  await inspectionTurn($, received.text ?? '', '확인했습니다.')

  world.refuse = '수신 세션 종료'
  await $.session.send({ to: 'dev-session', text: '2차', origin: { kind: 'model' } })
  await clock.advance(2000)

  expect(shared(world, TODO_PLAN).relay).toEqual([{ title: '1차', status: 'reviewing' }])
})

test('plan treats a message to the dev name or address it learned from a report as an instruction', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)
  // report()의 봉투: from="uds:/tmp/cc-socks/1.sock" from-name="control-center-1"
  await $.session.receive(report('[개발 보고] 1차'))

  const byName = await $.session.send({ to: 'control-center-1', text: '2차 작업', origin: { kind: 'model' } })
  const byAddress = await $.session.send({
    to: 'uds:/tmp/cc-socks/1.sock',
    text: '추가 지시',
    origin: { kind: 'model' },
  })

  expect(byName.isDelivered).toBe(true)
  expect(byAddress.isDelivered).toBe(true)
  expect(world.sends).toHaveLength(2)
  expect(world.sends.every(send => send.to.includes('S-DEV'))).toBe(true)
  expect((world.files.get(LOG) ?? '').split('[기획→개발] 지시 (S-PLAN → S-DEV)')).toHaveLength(3)
  await clock.advance(2000)
  expect(shared(world, TODO_PLAN).relay).toEqual([
    { title: '2차 작업', status: 'working' },
    { title: '추가 지시', status: 'working' },
  ])
})

test('plan does not use dev names learned from an earlier dev session', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  await $.session.receive(report('[개발 보고] 1차'))
  // 개발 세션이 바뀌었다.
  const roles = JSON.parse(world.files.get(ROLES) ?? '{}')
  roles.dev = { sessionId: 'S-DEV2', updatedAt: 't' }
  world.files.set(ROLES, JSON.stringify(roles))

  await $.session.send({ to: 'control-center-1', text: '2차 작업', origin: { kind: 'model' } })

  expect(world.sends[0]?.to).toBe('control-center-1')
  expect(world.files.get(LOG) ?? '').not.toContain('[기획→개발] 지시')
})

const mountBand = ($: Engine, maxRows = 20) =>
  $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows } })

test('plan draws the dev Todos read from the dev share under the matching instruction', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)
  await $.session.send({ to: 'dev-session', text: '경로 API 추가', origin: { kind: 'model' } })
  world.files.set(
    TODO_DEV,
    JSON.stringify({
      sessionId: 'S-DEV',
      todos: [{ id: '1', text: '테스트 작성', status: 'in_progress' }],
      relay: [],
      todoFor: '경로 API 추가',
    }),
  )
  await clock.advance(2000)

  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '릴레이 To-Do  완료 0/1' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '경로 API 추가  개발 중' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '테스트 작성' })).toBeDefined()
  await band.unmount()
})

test('dev draws the plan share and its own Todos in the same list', async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: tag('plan', 'S-PLAN', '경로 API 추가') } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: '테스트 작성', description: 'd' } as never)
  world.files.set(
    TODO_PLAN,
    JSON.stringify({
      sessionId: 'S-PLAN',
      todos: [{ id: '1', text: '계획 작성', status: 'in_progress' }],
      relay: [{ title: '경로 API 추가', status: 'working' }],
      todoFor: null,
    }),
  )
  await clock.advance(2000)

  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '기획 To-Do  완료 0/1' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '계획 작성' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '경로 API 추가  개발 중' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '테스트 작성' })).toBeDefined()
  await band.unmount()
})

test('plan ignores an old dev share, reads it again after it comes back and keeps it over broken JSON', async ($, on) => {
  const world = newWorld()
  const clock = await planWithDev($, on, world)
  await $.session.send({ to: 'dev-session', text: '경로 API 추가', origin: { kind: 'model' } })
  const share = (sessionId: string, text: string) =>
    JSON.stringify({ sessionId, todos: [{ text, status: 'pending' }], relay: [], todoFor: '경로 API 추가' })
  const shows = async (text: string) => {
    const band = await mountBand($)
    const found = await band.find({ type: 'Text', text })
    await band.unmount()
    return found !== undefined
  }

  // 다른 세션이 남긴 옛 파일은 무시한다.
  world.files.set(TODO_DEV, share('S-OLD', '옛 단계'))
  await clock.advance(2000)
  expect(await shows('옛 단계')).toBe(false)

  world.files.set(TODO_DEV, share('S-DEV', '새 단계'))
  await clock.advance(2000)
  expect(await shows('새 단계')).toBe(true)

  // 파일이 없어지면 지우고, 같은 글로 다시 생기면 다시 읽는다.
  world.files.delete(TODO_DEV)
  await clock.advance(2000)
  expect(await shows('새 단계')).toBe(false)
  world.files.set(TODO_DEV, share('S-DEV', '새 단계'))
  await clock.advance(2000)
  expect(await shows('새 단계')).toBe(true)

  // 깨진 글은 무시하고 직전 값을 유지한다.
  world.files.set(TODO_DEV, '{broken')
  await clock.advance(2000)
  expect(await shows('새 단계')).toBe(true)
})

test('band uses every row it may take and shows part of the list only past that', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  const steps = [...'ABCDEFGHIJKL'].map(letter => `단계 ${letter}`)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: steps.map(content => ({ content, status: 'pending', activeForm: content })),
  } as never)

  // 따로 정한 상한은 없다. maxRows 20이면 12개가 모두 보인다.
  const tall = await mountBand($)
  expect(await tall.find({ type: 'Text', text: '기획 To-Do  완료 0/12' })).toBeDefined()
  expect(await tall.find({ type: 'Text', text: '단계 L' })).toBeDefined()
  await tall.unmount()

  // maxRows 4: 이름표 1줄과 목록 3줄
  const short = await mountBand($, 4)
  expect(await short.find({ type: 'Text', text: '단계 B' })).toBeDefined()
  expect(await short.find({ type: 'Text', text: '단계 C' })).toBeUndefined()
  await short.unmount()
})

test("a session that lost its role to another session leaves that session's share alone", async ($, on) => {
  const world = newWorld()
  setRoles(world)
  const clock = engine(on, 'S-DEV', world)
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await clock.advance(2000)

  // 다른 세션이 개발 역할을 가져가 자기 몫을 썼다.
  const roles = JSON.parse(world.files.get(ROLES) ?? '{}')
  roles.dev = { sessionId: 'S-DEV2', updatedAt: 't' }
  world.files.set(ROLES, JSON.stringify(roles))
  const live = `${JSON.stringify({ sessionId: 'S-DEV2', todos: [], relay: [], todoFor: '새 작업' })}\n`
  world.files.set(TODO_DEV, live)

  // 다시 불러와 쓰기 기억이 비어도, /role off를 해도 그 세션의 파일을 덮어쓰지 않는다.
  await $.session.start({ cwd: '/Users/bmcho/Documents/git/control-center', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(2000)
  expect(world.files.get(TODO_DEV)).toBe(live)
  await $.command.run({ command: 'role', args: 'off' } as never)
  expect(world.files.get(TODO_DEV)).toBe(live)
})

type Drawn = { type: string; props?: Record<string, unknown>; children?: Drawn[] }

test('band keeps the character and the label at their width next to a long list line', async ($, on) => {
  const world = newWorld()
  await planWithDev($, on, world)
  const title = '로그인 화면에 이메일과 비밀번호 입력 검증을 추가하고 오류 문구를 보여 준다'
  await $.session.send({ to: 'dev-session', text: title, origin: { kind: 'model' } })

  // 긴 줄을 접으려고 터미널이 열을 줄이면 캐릭터와 이름표가 깨진다. 두 칸은 줄어들지 않아야 한다.
  const band = await mountBand($)
  const [art, right] = ((await band.drawn()) as Drawn).children ?? []
  const label = right?.children?.[0]?.children?.[0]
  expect(art?.props?.flexShrink).toBe(0)
  expect(label?.type).toBe('Box')
  expect(label?.props?.flexShrink).toBe(0)
  await band.unmount()
})

// 서브에이전트 정책: 모델 기본값, 동시 상한, effort
// 엔진처럼 띄운 에이전트를 목록에 일하는 중으로 올리고, 받은 spawn을 남긴다.
const spawner = (on: On, world: World) => {
  const spawned: { subagentType: string; model?: string }[] = []
  on('agent.spawn', ($, e) => {
    const id = `A${spawned.length + 1}`
    spawned.push({ subagentType: e.subagentType, model: e.model })
    world.agents = [...(world.agents ?? []), agent(id, 'running')]
    return { model: e.model ?? 'inherit', agentId: id }
  })
  return spawned
}

const spawn = ($: Engine, subagentType: string, more: Record<string, unknown> = {}) =>
  $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: '조사해 줘',
    description: '조사',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...more,
  } as never)

test('a relay session gives Explore haiku and leaves general-purpose to the session model', async ($, on) => {
  const world = newWorld()
  const spawned = spawner(on, world)
  await planWithDev($, on, world)

  await spawn($, 'Explore')
  await spawn($, 'general-purpose')

  expect(spawned).toEqual([
    { subagentType: 'Explore', model: 'haiku' },
    { subagentType: 'general-purpose', model: undefined },
  ])
})

test('a relay session keeps the model the call names and leaves other agent types alone', async ($, on) => {
  const world = newWorld()
  const spawned = spawner(on, world)
  await planWithDev($, on, world)

  await spawn($, 'Explore', { model: 'opus' })
  await spawn($, 'Plan')
  await spawn($, 'fork', { fork: true })

  expect(spawned.map(s => s.model)).toEqual(['opus', undefined, undefined])
})

test('a session without a role spawns agents as asked, with no cap', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-X', world)
  world.agents = ['A7', 'A8', 'A9'].map(id => agent(id, 'running'))
  const spawned = spawner(on, world)

  const started = await spawn($, 'Explore')

  expect(started.deny).toBeUndefined()
  expect(spawned).toEqual([{ subagentType: 'Explore', model: undefined }])
})

test('a relay session refuses a new agent while maxAgents agents work and tells the main loop why', async ($, on) => {
  const world = newWorld()
  const spawned = spawner(on, world)
  await planWithDev($, on, world)
  world.agents = ['A7', 'A8', 'A9'].map(id => agent(id, 'running'))

  const refused = await spawn($, 'Explore')

  expect(refused.deny).toContain('3개')
  expect(spawned).toHaveLength(0)

  // 하나가 끝나면 다시 띄울 수 있다.
  world.agents = ['A8', 'A9'].map(id => agent(id, 'running'))
  expect((await spawn($, 'Explore')).deny).toBeUndefined()
})

test('maxAgents 0 lifts the cap', { options: { maxAgents: 0 } }, async ($, on) => {
  const world = newWorld()
  const spawned = spawner(on, world)
  await planWithDev($, on, world)
  world.agents = ['A6', 'A7', 'A8', 'A9'].map(id => agent(id, 'running'))

  expect((await spawn($, 'Explore')).deny).toBeUndefined()
  expect(spawned).toHaveLength(1)
})

test('agents spawned at once count toward the cap before they start', async ($, on) => {
  const world = newWorld()
  const spawned = spawner(on, world)
  await planWithDev($, on, world)

  const results = await Promise.all([1, 2, 3, 4].map(() => spawn($, 'Explore')))

  expect(results.filter(r => r.deny !== undefined)).toHaveLength(1)
  expect(spawned).toHaveLength(3)
})

// 모델 요청의 effort를 남기고 빈 응답으로 끝낸다.
const stepper = (on: On) => {
  const efforts: unknown[] = []
  on('turn.step', async function* ($, e) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  return efforts
}

const step = async ($: Engine, model: string, effort: string | undefined, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'T1', index: 0, model, effort, messageCount: 1, agentId } as never)
  for await (const chunk of stream) void chunk
  return stream.result
}

test('a relay session sets each subagent step effort by its model', async ($, on) => {
  const world = newWorld()
  const efforts = stepper(on)
  await planWithDev($, on, world)

  await step($, 'claude-haiku-5-5', 'max', 'A1')
  await step($, 'claude-sonnet-5-5', 'max', 'A2')
  await step($, 'claude-opus-5-5', 'medium', 'A3')
  await step($, 'claude-fable-5-1', 'medium', 'A4')

  expect(efforts).toEqual(['low', 'high', 'max', 'medium'])
})

test('main loop steps, sessions without a role and models without effort keep their effort', async ($, on) => {
  const world = newWorld()
  engine(on, 'S-X', world)
  const efforts = stepper(on)

  await step($, 'claude-haiku-5-5', 'max', 'A1')
  await $.command.run({ command: 'role', args: 'dev' } as never)
  await step($, 'claude-haiku-5-5', 'max')
  await step($, 'claude-haiku-5-5', undefined, 'A1')

  expect(efforts).toEqual(['max', 'max', undefined])
})

test(
  'the subagentEffort option sets the levels, and an unlisted model keeps its effort',
  { options: { subagentEffort: 'haiku=medium' } },
  async ($, on) => {
    const world = newWorld()
    const efforts = stepper(on)
    await planWithDev($, on, world)

    await step($, 'claude-haiku-5-5', 'max', 'A1')
    await step($, 'claude-sonnet-5-5', 'max', 'A2')

    expect(efforts).toEqual(['medium', 'max'])
  },
)

test(
  'a subagentEffort option with unknown pairs is reported when the session starts',
  { options: { subagentEffort: 'haiku=lo sonnet=high' } },
  async ($, on) => {
    const world = newWorld()
    engine(on, 'S-X', world)

    await $.session.start({ cwd: '/Users/bmcho/Documents/git/control-center', surface: 'terminal', isInteractive: true } as never)

    expect(world.toasts.join('\n')).toContain('haiku=lo')
  },
)
