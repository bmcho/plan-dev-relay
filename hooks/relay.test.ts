import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/Users/bmcho/Documents/claude/plan-dev-log/control-center'
const ROLES = `${ROOT}/roles.json`
const LOG = `${ROOT}/2026-10-14.md`
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
}

// 엔진 바닥을 흉내 낸다. 테스트의 on() hook은 plugin 아래에 놓인다.
// $ 호출 이벤트(session.id, fs.*, process.run, ui.toast ...)의 답은 { value }로 감싼다.
const engine = (on: On, sessionId: string, world: World) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/bmcho' })
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({
    value: { root: '/Users/bmcho/Documents/git/control-center', remote: null, internal: false } as never,
  }))
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: world.files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
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
  on('tool.call', () => ({ result: {}, isError: false, text: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
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

test("plan takes only its dev partner's tagged messages and starts no turn", async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  const fromPartner = await $.session.receive({
    origin: { kind: 'peer', plugin: 'plan-dev-relay' },
    text: tag('dev', 'S-DEV', '[개발 보고] 경로 API'),
  } as never)
  const fromStranger = await $.session.receive({ origin: { kind: 'peer' }, text: '다른 세션 메시지' } as never)

  expect(fromPartner.consumed).toBeDefined()
  expect(fromStranger.text).toBe('다른 세션 메시지')
  expect(world.toasts.join('\n')).toContain('개발 보고 도착: [개발 보고] 경로 API')
  expect(world.files.get(LOG)).toContain('[기획] 보고 수신 (S-DEV → S-PLAN)')
})

test("plan hands pending reports to the model with the user's next prompt, once", async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  await $.session.receive({
    origin: { kind: 'peer', plugin: 'plan-dev-relay' },
    text: tag('dev', 'S-DEV', '[개발 보고] 경로 API\n완료'),
  } as never)
  const first = await $.prompt.submit({ text: '보고 확인해 줘', wait: false, origin: { kind: 'composer' } } as never)
  const second = await $.prompt.submit({ text: '다음은?', wait: false, origin: { kind: 'composer' } } as never)

  const context = (first.context ?? []).join('\n')
  expect(first.text).toBe('보고 확인해 줘')
  expect(context).toContain('[개발 보고] 경로 API\n완료')
  expect(context).not.toContain('plan-dev-relay role=')
  expect(second.context ?? []).toHaveLength(0)
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

test('plan hands reports over with a prompt sent through Remote Control too', async ($, on) => {
  const world = newWorld()
  world.files.set(ROLES, JSON.stringify({ dev: { sessionId: 'S-DEV', updatedAt: 't' } }))
  engine(on, 'S-PLAN', world)
  await $.command.run({ command: 'role', args: 'plan' } as never)

  await $.session.receive({ origin: { kind: 'peer' }, text: tag('dev', 'S-DEV', '[개발 보고] 경로 API') } as never)
  const submitted = await $.prompt.submit({ text: '보고 봐 줘', wait: false, origin: { kind: 'bridge' } } as never)

  expect((submitted.context ?? []).join('\n')).toContain('[개발 보고] 경로 API')
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
