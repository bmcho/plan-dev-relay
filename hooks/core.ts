import type { ModelEffort } from 'claude-code'

import type { CommandRun, Review, Role, Task } from '../types'

// userConfig.logRoot의 기본값. ~는 각자의 홈 폴더로 바뀐다.
export const DEFAULT_LOG_ROOT = '~/Documents/claude/plan-dev-log'
export const REPORT_LIMIT = 8000

// userConfig.maxAgents와 userConfig.subagentEffort의 기본값
export const DEFAULT_MAX_AGENTS = 3
export const DEFAULT_EFFORT = 'haiku=low sonnet=high opus=high'

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

// 캐릭터 발 밑에 작게 보일 한 줄. 모델 id의 claude- 앞머리는 뗀다. effort를 받지 않는 모델은 모델만 보인다.
export const modelLine = (model: string, effort?: string | number) =>
  `${model.replace(/^claude-/, '')}${effort === undefined ? '' : ` · ${effort}`}`

// parseEffort의 반대: 설정에 저장할 한 줄. 모델 순서는 FAMILIES를 따른다.
export const effortText = (levels: EffortLevels) =>
  FAMILIES.flatMap(family => (levels[family] === undefined ? [] : [`${family}=${levels[family]}`])).join(' ')

// /agentEffort에서 레벨을 짧게 쓰는 이름. 설정에는 전체 이름으로 저장한다.
const SHORT_LEVELS: Record<string, string> = { l: 'low', m: 'medium', h: 'high', xh: 'xhigh' }

// /agentEffort의 인자: 모델 하나와 레벨 하나. 레벨은 l, m, h, xh, max나 전체 이름이다.
export const parseAgentEffort = (args: string) => {
  const [model = '', level = '', ...rest] = args.trim().split(/\s+/)
  if (rest.length > 0) return null
  const { levels, bad } = parseEffort(`${model}=${SHORT_LEVELS[level.toLowerCase()] ?? level}`)
  return bad.length === 0 ? levels : null
}

// /subagents의 인자. 0 이상의 정수만 받는다.
export const parseCap = (arg: string) => (/^\d+$/.test(arg) ? Number(arg) : null)

export const SUBAGENTS_USAGE = '사용법: /subagents [n] (n은 동시에 일하는 서브에이전트 상한, 0이면 제한 없음)'
export const AGENT_EFFORT_USAGE = `사용법: /agentEffort [${FAMILIES.join(' | ')}] [l | m | h | xh | max] (low, medium, high, xhigh로 써도 된다)`

// 기획 세션의 서브에이전트에게 막는 도구. Monitor는 셸 명령을 돌린다. 기획 메인은 계획 문서를 쓰므로 막지 않는다.
const PLAN_SUBAGENT_BLOCKED = new Set(['Edit', 'Write', 'NotebookEdit', 'Monitor'])

// 읽기만 하는 명령. 이 Claude Code에는 Grep·Glob 도구가 없어서 찾기도 Bash로 한다.
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'find', 'ls', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'diff', 'cmp', 'file', 'stat', 'du', 'tree', 'pwd', 'cd', 'echo', 'printf', 'sed', 'awk', 'jq', 'git',
  'basename', 'dirname', 'realpath', 'which', 'nl', 'column', 'comm', 'true', 'test', '[', '[[', 'export', 'date', 'sleep',
])
const READ_GIT = new Set([
  'log', 'diff', 'show', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file',
])
const WRITE_FIND = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/
// sed의 w 명령(파일에 쓴다): 'w 파일', s/a/b/w 파일
const SED_WRITE = /(?:^|[\s;{}'"/])w\s+[^\s'";}]/
// 명령 앞에 와도 되는 셸 문법 단어와, 혼자 오면 아무것도 하지 않는 단어
const LEAD_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time'])
const END_WORDS = new Set(['done', 'fi', '}'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
// 다른 명령을 실행만 하는 명령. 감싼 명령을 대신 본다. timeout은 시간 인자 하나를 더 받는다.
const WRAPPERS = new Set(['caffeinate', 'nice', 'timeout', 'env', 'command'])
// 쓰기를 허용하는 곳: 임시 폴더(/tmp, macOS의 TMPDIR, Claude Code 작업 폴더의 tmp)
const TMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\S*\/\.claude\/jobs\/[^/]+\/tmp(?:\/|$))/
// 지워도 되는 빌드 산출물(기획 메인만)
const BUILD_OUTPUT = /(?:^|\/)(?:build|dist|target|out|node_modules|\.gradle|coverage)(?:\/|$)/
// 출력 돌리기 표시. splitCommand가 대상 경로 앞에 붙여 두고, 단어를 읽을 때 따로 본다.
const REDIRECT = '\u0001>'
// 여기 문서: <<'EOF' ... EOF. 본문은 따로 빼서 python이면 읽는다.
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g
// python 코드가 파일을 쓰는 흔한 방법(쓰기 모드로 열기, write_text, 지우기·옮기기)
const PY_FILE_WRITE =
  /\bopen\([^,)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]|\bmode\s*=\s*['"][rbt]*[wax+]|\.write_(?:text|bytes)\(|\bos\.(?:remove|unlink|rename|replace|rmdir|removedirs|makedirs|mkdir|chmod|truncate)\b|\bshutil\.(?:move|copy\w*|rmtree)\b|\.(?:unlink|touch|mkdir|rmdir|chmod|rename)\(/
// python 코드가 다른 프로그램을 돌리는 방법. 무엇을 돌리는지 알 수 없다.
const PY_RUN = /\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\b(?:exec|eval|__import__)\(/
const GRADLE = new Set(['./gradlew', 'gradlew', 'gradle'])
const GRADLE_VALUE_OPTIONS = new Set(['--tests', '-p', '--project-dir', '-x', '--exclude-task'])
const TEST_TASK = /^(?:test|check|cleanTest|\w*Tests?)$/
const SNAPSHOT_UPDATE = /^(?:-u|--update|--updateSnapshot|--update-snapshots?)$/
// 기획 메인에게 막는 명령: 프로젝트의 파일과 git 기록·원격을 바꾸는 것
const PROJECT_WRITE = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'ln', 'touch', 'truncate', 'shred', 'dd', 'install', 'tee'])
const COPY_LIKE = new Set(['cp', 'ln', 'install'])
const GIT_WRITE = new Set([
  'add', 'rm', 'mv', 'commit', 'push', 'pull', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'stash', 'tag',
  'cherry-pick', 'revert', 'apply', 'am', 'clean',
])

// 따옴표 밖의 공백으로 단어를 나눈다. \는 다음 글자를 그대로 둔다.
const wordsOf = (part: string) => {
  const words: string[] = []
  let word = ''
  let quote = ''
  for (let i = 0; i < part.length; i += 1) {
    const c = part[i] ?? ''
    if (c === '\\' && quote !== "'") {
      word += part.slice(i, i + 2)
      i += 1
    } else if (quote === '' && /\s/.test(c)) {
      if (word !== '') words.push(word)
      word = ''
    } else {
      if (quote === '' && (c === "'" || c === '"')) quote = c
      else if (c === quote) quote = ''
      word += c
    }
  }
  return word === '' ? words : [...words, word]
}

type Split = { parts: string[]; bodies: string[]; ok: boolean }

// 따옴표 밖의 |, &&, ||, ;, &, 줄바꿈으로 명령을 나눈다. 여기 문서의 본문은 bodies로 빼낸다.
// $(...), <(...), `...` 안의 명령도 조각으로 함께 모은다. 출력 돌리기는 대상 앞에 REDIRECT를 붙여 둔다.
// 읽지 못하는 모양(짝 없는 <<, 닫히지 않은 치환, 대상 없는 >)이 있으면 ok가 false다.
const splitCommand = (command: string): Split => {
  const bodies: string[] = []
  const text = command
    .replace(HEREDOC, (_all: string, _quote: string, _name: string, rest: string, body: string) => {
      bodies.push(body)
      return ` HEREDOC${bodies.length - 1}${rest}`
    })
    .replace(/(^|\s)(\d?>|&>)\s*\/dev\/null|(^|\s)\d?>&\d/g, ' ')
  const parts: string[] = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? ''
    const two = text.slice(i, i + 2)
    if (c === '\\' && quote !== "'") {
      current += two
      i += 1
    } else if (quote !== "'" && (two === '$(' || (quote === '' && two === '<(') || c === '`')) {
      let end = c === '`' ? text.indexOf('`', i + 1) : -1
      for (let depth = 0, j = i + 1; c !== '`' && j < text.length; j += 1) {
        if (text[j] === '(') depth += 1
        else if (text[j] === ')' && --depth === 0) {
          end = j
          break
        }
      }
      if (end === -1) return { parts, bodies, ok: false }
      const inner = splitCommand(text.slice(i + (c === '`' ? 1 : 2), end))
      inner.parts.forEach(part => parts.push(part))
      inner.bodies.forEach(body => bodies.push(body))
      if (!inner.ok) return { parts, bodies, ok: false }
      current += 'X'
      i = end
    } else if (quote !== '') {
      if (c === quote) quote = ''
      current += c
    } else if (c === "'" || c === '"') {
      quote = c
      current += c
    } else if (c === '>') {
      const target = /^>{1,2}\s*(\S+)/.exec(text.slice(i))
      if (target === null) return { parts: [...parts, current], bodies, ok: false }
      current += ` ${REDIRECT}${target[1]} `
      i += target[0].length - 1
    } else if (two === '<<') {
      return { parts: [...parts, current], bodies, ok: false }
    } else if (two === '&&' || two === '||') {
      parts.push(current)
      current = ''
      i += 1
    } else if ('|;&\n'.includes(c)) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  return { parts: [...parts, current], bodies, ok: true }
}

// 명령을 차례로 읽으며 기억하는 것: 대입한 변수와, 지금 바깥 폴더에 있는지(cd).
// root가 있으면(기획 메인) 그 폴더 밖이 바깥이고, 없으면(서브에이전트) 임시 폴더만 바깥이다.
type ShellState = { vars: Map<string, string>; inTemp: boolean; root?: string }
const newState = (root?: string): ShellState => ({ vars: new Map(), inTemp: false, root })

const unquote = (word: string) => word.replace(/^(['"])([\s\S]*)\1$/, '$2')

// 경로 앞의 $이름, ${이름}을 이 명령에서 대입한 값으로 바꾼다.
const expand = (word: string, state: ShellState) =>
  unquote(word).replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/, (all: string, name: string) => state.vars.get(name) ?? all)

// 경로가 바깥(임시 폴더, 또는 root 밖)인지. 상대 경로는 지금 바깥에 있을 때만 그렇다. ~ 경로는 root 밖으로 본다.
const isTemp = (word: string, state: ShellState) => {
  const path = expand(word, state)
  if (TMP_PATH.test(path)) return true
  if (!/^[/~$]/.test(path)) return state.inTemp
  const { root } = state
  return root !== undefined && !path.startsWith('$') && path !== root && !path.startsWith(`${root}/`)
}

// 조각 하나를 명령 이름, 인자, 출력 대상으로 나눈다. 셸 문법 단어, 변수 대입, 감싸는 명령은 건너뛴다.
const commandOf = (part: string, state: ShellState) => {
  let words = wordsOf(part)
  const redirects = words.filter(word => word.startsWith(REDIRECT)).map(word => word.slice(REDIRECT.length))
  words = words.filter(word => !word.startsWith(REDIRECT))
  while (LEAD_WORDS.has(words[0] ?? '')) words = words.slice(1)
  for (let found = ASSIGNMENT.exec(words[0] ?? ''); found !== null; found = ASSIGNMENT.exec(words[0] ?? '')) {
    state.vars.set(found[1] ?? '', expand(found[2] ?? '', state))
    words = words.slice(1)
  }
  while (WRAPPERS.has(words[0] ?? '')) {
    const wrapper = words[0]
    words = words.slice(1)
    while ((words[0] ?? '').startsWith('-') || ASSIGNMENT.test(words[0] ?? '')) words = words.slice(1)
    if (wrapper === 'timeout') words = words.slice(1)
  }
  const [name = '', ...args] = words
  return { name, args, redirects }
}

// git 앞 옵션(-C 경로, -c 설정, --no-pager 등)을 건너뛰고 하위 명령과 -C 경로를 찾는다.
const gitOf = (args: string[]) => {
  let i = 0
  let dir: string | undefined
  while ((args[i] ?? '').startsWith('-')) {
    if (args[i] === '-C') dir = args[i + 1]
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  }
  return { sub: args[i] ?? '', dir }
}

const inlinePython = (args: string[], part: string, bodies: string[]) => {
  const inline = args.indexOf('-c')
  const heredoc = /HEREDOC(\d+)/.exec(part)
  return inline !== -1 ? (args[inline + 1] ?? '') : heredoc === null ? null : (bodies[Number(heredoc[1])] ?? '')
}

// 테스트 실행: 빌드 산출물만 쓰고 소스는 고치지 않는다. 스냅숏을 고치는 옵션은 막는다.
const isTestRun = (name: string, args: string[]) => {
  if (args.some(arg => SNAPSHOT_UPDATE.test(arg))) return false
  const plain = args.filter((arg, i) => !arg.startsWith('-') && !GRADLE_VALUE_OPTIONS.has(args[i - 1] ?? ''))
  if (GRADLE.has(name)) return plain.length > 0 && plain.every(task => TEST_TASK.test(task.split(':').pop() ?? ''))
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    return plain[0] === 'test' || plain[0] === 't' || (plain[0] === 'run' && /^test(?::|$)/.test(plain[1] ?? ''))
  }
  if (name === 'go' || name === 'cargo') return plain[0] === 'test'
  if (name === 'mvn') return plain.length > 0 && plain.every(goal => goal === 'test' || goal === 'verify')
  return name === 'pytest'
}

// 서브에이전트용: 조각 하나가 읽기나 테스트, 임시 폴더 쓰기인지 본다. 목록에 없는 명령은 막는다.
const isReadOnlyPart = (part: string, bodies: string[], state: ShellState) => {
  const { name, args, redirects } = commandOf(part, state)
  if (!redirects.every(target => isTemp(target, state))) return false
  if (name === '' || END_WORDS.has(name) || name === 'for') return true
  if (name === 'cd') {
    state.inTemp = isTemp(args[0] ?? '~', state)
    return true
  }
  if (name === 'python3' || name === 'python') {
    const module = args.indexOf('-m')
    if (module !== -1) return args[module + 1] === 'pytest'
    const code = inlinePython(args, part, bodies)
    return code !== null && !PY_FILE_WRITE.test(code) && !PY_RUN.test(code)
  }
  if (name === 'mkdir') return args.filter(arg => !arg.startsWith('-')).every(arg => isTemp(arg, state))
  if (isTestRun(name, args)) return true
  if (!READ_COMMANDS.has(name)) return false
  if (name === 'sed') return !args.some(arg => arg.startsWith('-i') || arg === '--in-place') && !SED_WRITE.test(args.join(' '))
  if (name === 'find') return !args.some(arg => WRITE_FIND.test(arg))
  if (name === 'awk') return !part.includes('system(')
  if (name === 'git') {
    const { sub } = gitOf(args)
    return READ_GIT.has(sub) && !args.some(arg => arg.startsWith('--output'))
  }
  return true
}

// 셸 명령이 작업 폴더의 파일을 바꾸지 않는지(읽기, 테스트, 임시 폴더 쓰기) 본다. 목록에 없는 명령은 막는다.
// shortcut: 셸 문법과 python 코드를 흔한 모양으로만 읽는다, 쓰는 명령이 지나가면 셸 파서와 쓰기 감지를 늘린다.
export function isReadOnlyCommand(command: string): boolean {
  const split = splitCommand(command)
  const state = newState()
  return split.ok && split.parts.every(part => isReadOnlyPart(part, split.bodies, state))
}

// 기획 메인용: 조각 하나가 프로젝트의 파일이나 git 기록·원격을 바꾸는지 본다.
// 임시 폴더 안의 일과 빌드 산출물 지우기는 바꾸지 않는 것으로 본다. 모르는 명령은 두고 본다.
const isWritePart = (part: string, bodies: string[], state: ShellState) => {
  const { name, args, redirects } = commandOf(part, state)
  if (!redirects.every(target => isTemp(target, state))) return true
  const paths = args.filter(arg => !arg.startsWith('-'))
  const safe = (path: string) => isTemp(path, state) || BUILD_OUTPUT.test(expand(path, state))
  if (name === 'cd') state.inTemp = isTemp(args[0] ?? '~', state)
  if (PROJECT_WRITE.has(name)) {
    const written = COPY_LIKE.has(name) ? paths.slice(-1) : paths
    return !(written.length > 0 && written.every(safe))
  }
  if (name === 'git') {
    const { sub, dir } = gitOf(args)
    const where = dir === undefined ? state.inTemp : isTemp(dir, state)
    // git apply --check·--stat은 바꾸지 않고 확인만 한다.
    const dryRun = sub === 'apply' && args.some(arg => /^--(?:check|stat|numstat|summary)$/.test(arg))
    return (
      !where &&
      !dryRun &&
      (GIT_WRITE.has(sub) || (sub === 'branch' && args.some(arg => /^-(?:[dDmM]|-delete|-move)$/.test(arg))))
    )
  }
  if (name === 'sed' || name === 'perl') {
    return args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place') && !safe(paths[paths.length - 1] ?? '')
  }
  if (name === 'python3' || name === 'python') return !state.inTemp && PY_FILE_WRITE.test(inlinePython(args, part, bodies) ?? '')
  return false
}

// 기획 메인의 Bash 명령이 프로젝트(root 폴더)의 파일이나 git 기록·원격을 바꾸는지 본다.
// root 밖(임시 폴더, Claude 메모리 등)에 쓰는 것은 바꾸지 않는 것이다.
export function isProjectWrite(command: string, root: string): boolean {
  const split = splitCommand(command)
  const state = newState(root)
  return !split.ok || split.parts.some(part => isWritePart(part, split.bodies, state))
}

// 기획 세션에서 이 도구 호출을 받아도 되는지.
// 서브에이전트: 파일 수정 도구를 못 쓰고, Bash는 읽기, 테스트, 임시 폴더 쓰기만 된다.
// 메인: 계획 문서를 Write·Edit로 쓰고 빌드·테스트도 돌린다. Bash로 프로젝트(root 폴더) 파일이나 git 기록·원격을 바꾸는 것만 막는다.
export const planMay = (tool: string, command: string | undefined, isSubagent: boolean, root: string) =>
  isSubagent
    ? !PLAN_SUBAGENT_BLOCKED.has(tool) && (tool !== 'Bash' || isReadOnlyCommand(command ?? ''))
    : tool !== 'Bash' || !isProjectWrite(command ?? '', root)

export const PLAN_SUBAGENT_DENY =
  '기획 세션의 서브에이전트는 파일을 고칠 수 없습니다. Edit, Write는 쓸 수 없고, Bash는 읽기 명령(grep, rg, find, cat, git log·diff·show 등)과 테스트 실행만 됩니다. 고칠 일은 기획 세션이 개발 세션에 지시합니다.'
export const PLAN_MAIN_DENY =
  '기획 세션은 Bash로 프로젝트 파일을 지우거나 옮기거나 고칠 수 없고, git add·commit·push 같은 변경도 할 수 없습니다. 이 일은 개발 세션에 지시하세요. 읽기, 빌드, 테스트와 프로젝트 폴더 밖(임시 폴더 등)의 작업은 됩니다. 계획 문서는 Write·Edit로 씁니다.'
export const PLAN_GUARD_FAILED = '기획 세션의 도구 확인이 실패해 이 호출을 막았습니다. 다시 시도하세요.'

// 0이면 제한하지 않는다. 0 이상의 정수가 아니면 기본값을 쓴다.
export const agentCap = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_AGENTS

// 찾기·조회·설정처럼 가벼운 엔진 서브에이전트 종류
const QUICK_TYPES = new Set(['Explore', 'claude-code-guide', 'statusline-setup'])

// 호출이 model을 비운 엔진 서브에이전트의 기본 모델. 별칭은 Claude Code가 최신 모델로 바꾼다.
// 기획 세션의 general-purpose는 조사·정리·테스트 실행을 하므로 sonnet이다. 나머지는 세션 모델이나 자기 정의를 따른다.
export const defaultModel = (subagentType: string, role: Role) =>
  QUICK_TYPES.has(subagentType)
    ? 'haiku'
    : role === 'plan' && subagentType === 'general-purpose'
      ? 'sonnet'
      : undefined

const KST_MS = 9 * 60 * 60 * 1000

export type Roles = Partial<Record<Role, { sessionId: string; updatedAt: string }>>

export const roleLabel = (role: Role) => (role === 'plan' ? '기획' : '개발')

// Windows 경로(~\, C:\...)의 역슬래시도 나누는 기호로 본다.
export const expandHome = (path: string, home: string) =>
  path === '~' ? home : /^~[\\/]/.test(path) ? `${home}${path.slice(1)}` : path

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

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
  '서브에이전트: 찾기·위치 파악은 Explore로 띄운다. 서브에이전트의 model은 사용자가 모델을 지정했을 때만 적는다. 그 밖에는 비워 두면 mod가 종류에 맞는 기본 모델로 띄운다.',
  '동시에 일하는 서브에이전트가 상한에 닿으면 mod가 새 에이전트를 거절한다. 그때는 일하는 에이전트가 끝난 뒤 다시 띄우거나 직접 한다.',
]

export const planGuide = () =>
  [
    '# plan-dev-relay: 기획 역할',
    '이 세션은 기획 담당이다. 구현과 수정은 직접 하지 말고 개발 세션에 지시한다.',
    '서브에이전트에게도 구현이나 수정을 맡기지 않는다. 서브에이전트는 찾기, 조사, 설계 비교, 테스트 실행에만 쓴다. 파일 고치기, 지우기, 커밋, push는 개발 세션에 지시한다. mod가 기획 세션의 Bash는 읽기와 테스트만 받고, 서브에이전트의 Edit·Write는 막는다.',
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
