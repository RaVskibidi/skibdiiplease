/** T77 visual identity colors. Keep in sync with dashboard CSS variables. */
export const T77_COLORS = {
  black: 0x09090b,
  surface: 0x141418,
  surfaceRaised: 0x1c1c22,
  border: 0x2a2a32,
  red: 0xe5484d,
  redDark: 0xb4232a,
  redSoft: 0x3a1519,
  text: 0xf4f4f5,
  muted: 0xa1a1aa,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  info: 0x38bdf8,
} as const;

export type T77ColorName = keyof typeof T77_COLORS;

export const T77_CSS_COLORS = {
  black: '#09090b',
  surface: '#141418',
  surfaceRaised: '#1c1c22',
  border: '#2a2a32',
  red: '#e5484d',
  redDark: '#b4232a',
  redSoft: '#3a1519',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#38bdf8',
} as const;
