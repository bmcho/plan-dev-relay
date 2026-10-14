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
