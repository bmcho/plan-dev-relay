import type { Role } from '../types'

export const ORANGE = '#D97757'

export const LABEL_STYLE: Record<Role, { color: string; backgroundColor: string }> = {
  plan: { color: '#FFFFFF', backgroundColor: '#1F6FEB' },
  dev: { color: '#000000', backgroundColor: '#2EA043' },
}

const THOUGHT = ['?', '…', '!']
const CURSOR = ['▌  ', '▌▌ ', '▌▌▌']
const DESK = ['═╧══╧═', '═╤══╤═']

const planArt = (frame: number) => {
  const step = Math.floor(frame / 2) % 3
  const box = (index: number) => (index < step ? '☑' : '☐')
  return [
    `            .oO( ${THOUGHT[step]} )`,
    ' ▐▛███▜▌   ┌────────┐',
    `▝▜█████▛▘──│ ${box(0)} 요구 │`,
    `  ▘▘ ▝▝    │ ${box(1)} 설계 │`,
    '           └────────┘',
  ]
}

const devArt = (frame: number) => [
  '  ▄███▄',
  ' ▐▛███▜▌   ┌────────┐',
  `▝▜█████▛▘  │ >_ ${CURSOR[frame % 3]} │`,
  '  ▘▘ ▝▝    └──┬──┬──┘',
  `             ${DESK[frame % 2]}`,
]

export const artFor = (role: Role, frame: number) =>
  role === 'plan' ? planArt(frame) : devArt(frame)

// 서브에이전트 pane의 캐릭터. band의 Claude를 종류마다 조금 바꾸고, 2행(손 높이)에 소품을 든다.
const BODY = '▝▜█████▛▘'
const LEGS = '  ▘▘ ▝▝'
// 정찰병(Explore)은 둥근 머리로 두리번거리며 돋보기로 훑는다.
const EYES = [' ▗▛███▜▖', ' ▗▜██▛█▖', ' ▗▛███▜▖', ' ▗█▜██▛▖']
const LENS = ['─⌕··', '─·⌕·', '─··⌕']
const CHECKS = ['─☐☐☐', '─☑☐☐', '─☑☑☐', '─☑☑☑']
const PROMPT = ['─>_▌', '─>_ ']
// 캐릭터 칸의 너비. 글 칸이 에이전트마다 같은 곳에서 시작하게 모든 줄을 이 너비로 채운다.
const AGENT_ART_WIDTH = 13

export const agentArt = (type: string, frame: number) => {
  const step = Math.floor(frame / 2)
  const lines =
    type === 'Explore'
      ? [EYES[step % 4], `${BODY}${LENS[step % 3]}`, LEGS]
      : type === 'Plan'
        ? [' ▐▀███▀▌', `${BODY}${CHECKS[step % 4]}`, LEGS]
        : type === 'general-purpose'
          ? [' ▄█████▄', `▗▟▙███▟▙▖${PROMPT[step % 2]}`, ' ▝█▀▀▀█▘']
          : [` ▐▛███▜▌  oO${THOUGHT[step % 3]}`, BODY, LEGS]
  return lines.map(line => (line ?? '').padEnd(AGENT_ART_WIDTH))
}
