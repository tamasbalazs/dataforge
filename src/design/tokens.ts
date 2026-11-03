/**
 * DataForge design tokens — the single source of truth for colour, type,
 * spacing, radii, elevation and motion. CSS variables, the Monaco theme and
 * the plot theme are all generated from these values.
 */

export type ThemeMode = 'light' | 'dark';

export interface Palette {
  // Surfaces, from the window background up to pressed controls.
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  overlay: string;
  borderSubtle: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDisabled: string;
  accent: string;
  accentHover: string;
  accentFg: string;
  accentSoft: string;
  accentText: string;
  focusRing: string;
  success: string;
  warning: string;
  danger: string;
  /** Text on a danger-coloured (destructive) button. */
  dangerFg: string;
  info: string;
  dangerSoft: string;
  warningSoft: string;
  successSoft: string;
  // Data type colours (environment panel, data viewer).
  typeNumeric: string;
  typeText: string;
  typeLogical: string;
  typeFactor: string;
  typeDate: string;
  typeData: string;
  typeFunction: string;
  typeList: string;
  // Syntax highlighting.
  synKeyword: string;
  synString: string;
  synNumber: string;
  synComment: string;
  synFunction: string;
  synOperator: string;
  synConstant: string;
  synType: string;
  // Categorical plot palette.
  chart: string[];
  shadowColor: string;
}

export const palettes: Record<ThemeMode, Palette> = {
  dark: {
    surface0: '#0D0F13',
    surface1: '#13161B',
    surface2: '#191C23',
    surface3: '#21252D',
    surface4: '#2A2F39',
    overlay: 'rgba(5, 6, 9, 0.62)',
    borderSubtle: '#1D2128',
    border: '#272C35',
    borderStrong: '#363C48',
    textPrimary: '#E7E9EE',
    textSecondary: '#A9B0BC',
    textMuted: '#8D95A3',
    textDisabled: '#565D6A',
    accent: '#7C8CFF',
    accentHover: '#93A0FF',
    accentFg: '#0D0F13',
    accentSoft: 'rgba(124, 140, 255, 0.14)',
    accentText: '#A3AEFF',
    focusRing: 'rgba(124, 140, 255, 0.55)',
    success: '#4CC38A',
    warning: '#E8A64C',
    danger: '#F27474',
    dangerFg: '#1A0B0B',
    info: '#62B0F0',
    dangerSoft: 'rgba(242, 116, 116, 0.10)',
    warningSoft: 'rgba(232, 166, 76, 0.10)',
    successSoft: 'rgba(76, 195, 138, 0.12)',
    typeNumeric: '#8C9BFF',
    typeText: '#E8B05C',
    typeLogical: '#C9A0FF',
    typeFactor: '#F28CC0',
    typeDate: '#4FD1C5',
    typeData: '#4CC38A',
    typeFunction: '#62B0F0',
    typeList: '#B7A57A',
    synKeyword: '#B9A6FF',
    synString: '#9FD49A',
    synNumber: '#F2B880',
    synComment: '#7A8292',
    synFunction: '#7FBBFF',
    synOperator: '#9AA4B5',
    synConstant: '#F28CC0',
    synType: '#5FD3C6',
    chart: ['#7C8CFF', '#F2A65A', '#4CC38A', '#F27474', '#5FD3C6', '#C9A0FF', '#E8C35C', '#F28CC0'],
    shadowColor: '0 0% 0%',
  },
  light: {
    surface0: '#F4F5F7',
    surface1: '#FFFFFF',
    surface2: '#F7F8FA',
    surface3: '#EEF0F3',
    surface4: '#E4E7EC',
    overlay: 'rgba(20, 22, 28, 0.28)',
    borderSubtle: '#ECEEF1',
    border: '#E1E4E9',
    borderStrong: '#CBD0D8',
    textPrimary: '#15171C',
    textSecondary: '#474E5B',
    textMuted: '#646B78',
    textDisabled: '#A3A9B4',
    accent: '#4C58D6',
    accentHover: '#3E49C4',
    accentFg: '#FFFFFF',
    accentSoft: 'rgba(76, 88, 214, 0.09)',
    accentText: '#3D48BF',
    focusRing: 'rgba(76, 88, 214, 0.45)',
    success: '#1D7F53',
    warning: '#9A5B00',
    danger: '#C93636',
    dangerFg: '#FFFFFF',
    info: '#1F6FB2',
    dangerSoft: 'rgba(201, 54, 54, 0.07)',
    warningSoft: 'rgba(154, 91, 0, 0.07)',
    successSoft: 'rgba(29, 127, 83, 0.08)',
    typeNumeric: '#4C58D6',
    typeText: '#9A5B00',
    typeLogical: '#7A3FD1',
    typeFactor: '#B8327A',
    typeDate: '#0F7A72',
    typeData: '#1D7F53',
    typeFunction: '#1F6FB2',
    typeList: '#7A6634',
    synKeyword: '#6D3BD8',
    synString: '#2C7A33',
    synNumber: '#A65308',
    synComment: '#6B7280',
    synFunction: '#1E5FC8',
    synOperator: '#4B5563',
    synConstant: '#B8327A',
    synType: '#0F7A72',
    chart: ['#4C58D6', '#E07B24', '#1D9A62', '#D64545', '#139C93', '#8A55E0', '#C49A1C', '#D0559A'],
    shadowColor: '220 20% 20%',
  },
};

export const typography = {
  fontUi: `'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`,
  fontMono: `'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace`,
  size: { xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 24 },
  weight: { regular: 400, medium: 500, semibold: 600 },
  lineHeight: { tight: 1.25, normal: 1.5 },
};

export const space = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40] as const;
export const radius = { xs: 4, sm: 6, md: 8, lg: 10, xl: 14, full: 999 };
export const motion = {
  fast: 150,
  medium: 200,
  slow: 250,
  easeOut: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
};

export const kebab = (s: string) => s.replace(/[A-Z]|\d+/g, (m) => '-' + m.toLowerCase());

/** All CSS custom properties for a theme mode. */
export function cssVariables(mode: ThemeMode, overrides: Partial<Palette> = {}): Record<string, string> {
  const p = { ...palettes[mode], ...overrides };
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'chart') {
      (v as string[]).forEach((c, i) => (vars[`--chart-${i + 1}`] = c));
    } else if (k !== 'shadowColor') {
      vars[`--${kebab(k)}`] = v as string;
    }
  }
  const sc = p.shadowColor;
  const strength = mode === 'dark' ? [0.35, 0.45, 0.55] : [0.06, 0.1, 0.14];
  vars['--shadow-sm'] = `0 1px 2px hsl(${sc} / ${strength[0]})`;
  vars['--shadow-md'] = `0 4px 12px -2px hsl(${sc} / ${strength[1]}), 0 1px 3px hsl(${sc} / ${strength[0]})`;
  vars['--shadow-lg'] = `0 16px 48px -8px hsl(${sc} / ${strength[2]}), 0 4px 12px hsl(${sc} / ${strength[0]})`;
  vars['--font-ui'] = typography.fontUi;
  vars['--font-mono'] = typography.fontMono;
  for (const [k, v] of Object.entries(typography.size)) vars[`--text-${k}`] = `${v}px`;
  space.forEach((v, i) => (vars[`--space-${i}`] = `${v}px`));
  for (const [k, v] of Object.entries(radius)) vars[`--radius-${k}`] = `${v}px`;
  vars['--dur-fast'] = `${motion.fast}ms`;
  vars['--dur-medium'] = `${motion.medium}ms`;
  vars['--dur-slow'] = `${motion.slow}ms`;
  vars['--ease-out'] = motion.easeOut;
  vars['--ease-in-out'] = motion.easeInOut;
  return vars;
}

export function applyTheme(mode: ThemeMode, overrides: Partial<Palette> = {}, root: HTMLElement = document.documentElement) {
  const vars = cssVariables(mode, overrides);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

// ---------------------------------------------------------------------------
// WCAG contrast helpers (also used by the theme validator tests).

export function parseColor(c: string): [number, number, number, number] {
  const hex = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgb = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const [r, g, b, a = '1'] = rgb[1].split(',').map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`Unsupported colour: ${c}`);
}

/** Composite a (possibly translucent) colour over an opaque background. */
export function composite(fg: string, bg: string): [number, number, number] {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  return [r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)];
}

export function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(composite(fg, bg));
  const l2 = luminance(composite(bg, '#000000'));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text/background pairs that must meet WCAG AA (4.5:1). */
export const contrastPairs: Array<[keyof Palette, keyof Palette]> = [
  ['textPrimary', 'surface0'],
  ['textPrimary', 'surface1'],
  ['textPrimary', 'surface3'],
  ['textSecondary', 'surface1'],
  ['textSecondary', 'surface2'],
  ['textMuted', 'surface1'],
  ['textMuted', 'surface2'],
  ['textMuted', 'surface3'],
  ['dangerFg', 'danger'],
  ['accentFg', 'accent'],
  ['accentText', 'surface1'],
  ['danger', 'surface1'],
  ['warning', 'surface1'],
  ['success', 'surface1'],
  ['info', 'surface1'],
  ['synKeyword', 'surface1'],
  ['synString', 'surface1'],
  ['synNumber', 'surface1'],
  ['synComment', 'surface1'],
  ['synFunction', 'surface1'],
  ['typeNumeric', 'surface1'],
  ['typeText', 'surface1'],
  ['typeData', 'surface1'],
  ['typeFunction', 'surface1'],
];

/** Colours handed to the R/Python helpers so plots match the UI theme. */
export function plotTheme(mode: ThemeMode, overrides: Partial<Palette> = {}) {
  const p = { ...palettes[mode], ...overrides };
  return { bg: p.surface1, fg: p.textPrimary, muted: p.textSecondary, grid: p.border, palette: p.chart };
}
