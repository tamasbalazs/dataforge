/**
 * Custom themes: the DataForge theme format, VS Code colour-theme import, and
 * a WCAG AA pass that fixes unreadable colours of imported themes. Pure functions.
 */
import { contrastPairs, contrastRatio, luminance, palettes, parseColor, type Palette, type ThemeMode } from '../design/tokens';

export const THEME_FORMAT = 'dataforge-theme/1';

export interface CustomTheme {
  id: string;
  name: string;
  type: ThemeMode;
  /** Overrides of the base palette of `type`. */
  colors: Partial<Palette>;
  /** Terminal ANSI palette (16 colours), optional. */
  ansi?: string[];
  author?: string;
  source: 'file' | 'vscode' | 'extension';
  extensionId?: string;
  /** Colours changed to meet WCAG AA when the theme was imported. */
  adjusted?: string[];
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
export const toHex = ([r, g, b]: number[]) => '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Any CSS hex (#rgb, #rrggbb, #rrggbbaa) or rgb[a]() colour → opaque #RRGGBB over `bg`. */
export function normalizeColor(c: string, bg = '#000000'): string | null {
  const s = c.trim();
  const m8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(s);
  try {
    if (m8) {
      const a = parseInt(m8[2], 16) / 255;
      const [r, g, b] = parseColor('#' + m8[1]);
      const [br, bgc, bb] = parseColor(bg);
      return toHex([r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)]);
    }
    const m4 = /^#([0-9a-f]{3})([0-9a-f])$/i.exec(s);
    if (m4) return normalizeColor('#' + m4[1].split('').map((x) => x + x).join('') + m4[2] + m4[2], bg);
    const [r, g, b, a] = parseColor(s);
    const [br, bgc, bb] = parseColor(bg);
    return toHex([r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)]);
  } catch {
    return null;
  }
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseColor(a);
  const [r2, g2, b2] = parseColor(b);
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseColor(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const isDarkColor = (hex: string) => luminance(parseColor(hex).slice(0, 3) as [number, number, number]) < 0.18;

/**
 * Raise the contrast of text-like colours until every WCAG pair passes 4.5:1,
 * nudging the foreground toward white (dark themes) or black (light themes).
 */
export function ensureContrast(type: ThemeMode, colors: Partial<Palette>): { colors: Partial<Palette>; adjusted: string[] } {
  const out: Partial<Palette> = { ...colors };
  const full = () => ({ ...palettes[type], ...out }) as Palette;
  const adjusted = new Set<string>();
  // accentFg is chosen, not nudged: whichever of near-black / white reads best on the accent.
  {
    const p = full();
    if (contrastRatio(p.accentFg, p.accent) < 4.5) {
      const dark = palettes.dark.surface0;
      out.accentFg = contrastRatio(dark, p.accent) >= contrastRatio('#FFFFFF', p.accent) ? dark : '#FFFFFF';
      adjusted.add('accentFg');
    }
  }
  for (const [fg, bg] of contrastPairs) {
    if (fg === 'accentFg') continue;
    const p = full();
    const bgc = p[bg] as string;
    let color = normalizeColor(p[fg] as string, bgc) ?? (palettes[type][fg] as string);
    const target = isDarkColor(bgc) ? '#FFFFFF' : '#000000';
    let guard = 0;
    while (contrastRatio(color, bgc) < 4.5 && guard++ < 40) color = mix(color, target, 0.06);
    if (color !== p[fg]) {
      if (normalizeColor(p[fg] as string, bgc) !== color) adjusted.add(fg);
      (out as Record<string, string>)[fg] = color;
    }
  }
  // Only keep keys that differ from the base palette or were explicitly set.
  for (const k of Object.keys(out) as Array<keyof Palette>) {
    if (!(k in colors) && !adjusted.has(k) && out[k] === palettes[type][k]) delete out[k];
  }
  return { colors: out, adjusted: [...adjusted] };
}

// ---------------------------------------------------------------------------
// VS Code colour themes

/** VS Code themes are JSONC: comments and trailing commas are allowed. */
export function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

/** Foreground of the most specific rule matching any of the scopes (prefix match, like TextMate). */
export function scopeColor(rules: TokenRule[], wanted: string[]): string | undefined {
  let best: { color: string; score: number } | undefined;
  for (const r of rules) {
    const fg = r.settings?.foreground;
    if (!fg) continue;
    const scopes = Array.isArray(r.scope) ? r.scope : (r.scope ?? '').split(',').map((s) => s.trim());
    for (const sc of scopes) {
      for (const w of wanted) {
        if (sc === w || w.startsWith(sc + '.')) {
          const score = sc.length + (sc === w ? 1000 : 0) - wanted.indexOf(w) * 0.1;
          if (!best || score > best.score) best = { color: fg, score };
        }
      }
    }
  }
  return best?.color;
}

export function fromVSCode(json: any, fallbackName = 'VS Code theme'): CustomTheme {
  const c: Record<string, string> = json?.colors ?? {};
  const rules: TokenRule[] = Array.isArray(json?.tokenColors) ? json.tokenColors : [];
  const editorBg = normalizeColor(c['editor.background'] ?? '') ?? undefined;
  const type: ThemeMode = json?.type === 'light' || json?.type === 'hc-light' ? 'light' : json?.type === 'dark' || json?.type === 'hc-black' ? 'dark' : editorBg && !isDarkColor(editorBg) ? 'light' : 'dark';
  const base = palettes[type];
  const bg = editorBg ?? base.surface1;
  const get = (keys: string[], over = bg) => {
    for (const k of keys) {
      const v = c[k] && normalizeColor(c[k], over);
      if (v) return v;
    }
    return undefined;
  };
  const fg = get(['editor.foreground', 'foreground']) ?? (type === 'dark' ? '#E7E9EE' : '#1F2328');
  const toward = (t: number) => mix(bg, fg, t);
  const colors: Partial<Palette> = {
    surface1: bg,
    surface0: get(['sideBar.background', 'activityBar.background', 'panel.background']) ?? (type === 'dark' ? mix(bg, '#000000', 0.25) : mix(bg, '#000000', 0.04)),
    surface2: get(['editorWidget.background', 'list.hoverBackground']) ?? toward(0.04),
    surface3: get(['list.activeSelectionBackground', 'editor.lineHighlightBackground']) ?? toward(0.09),
    surface4: toward(0.14),
    borderSubtle: toward(0.07),
    border: get(['panel.border', 'editorGroup.border', 'sideBar.border']) ?? toward(0.12),
    borderStrong: toward(0.2),
    textPrimary: fg,
    textSecondary: get(['descriptionForeground']) ?? mix(fg, bg, 0.25),
    textMuted: mix(fg, bg, 0.42),
    textDisabled: mix(fg, bg, 0.62),
  };
  const accent = get(['focusBorder', 'button.background', 'textLink.foreground', 'activityBarBadge.background']);
  if (accent) {
    colors.accent = accent;
    colors.accentHover = mix(accent, type === 'dark' ? '#FFFFFF' : '#000000', 0.12);
    colors.accentSoft = rgba(accent, 0.14);
    colors.focusRing = rgba(accent, 0.55);
    colors.accentText = get(['textLink.foreground']) ?? accent;
    const bfg = get(['button.foreground'], accent);
    if (bfg) colors.accentFg = bfg;
  }
  const status = {
    success: get(['gitDecoration.addedResourceForeground', 'terminal.ansiGreen', 'charts.green']),
    warning: get(['editorWarning.foreground', 'charts.yellow', 'terminal.ansiYellow']),
    danger: get(['editorError.foreground', 'errorForeground', 'terminal.ansiRed']),
    info: get(['editorInfo.foreground', 'charts.blue', 'terminal.ansiBlue']),
  };
  for (const [k, v] of Object.entries(status)) if (v) (colors as Record<string, string>)[k] = v;
  if (status.success) colors.successSoft = rgba(status.success, 0.12);
  if (status.warning) colors.warningSoft = rgba(status.warning, 0.1);
  if (status.danger) colors.dangerSoft = rgba(status.danger, 0.1);
  const syn = (scopes: string[]) => {
    const v = scopeColor(rules, scopes);
    return v ? (normalizeColor(v, bg) ?? undefined) : undefined;
  };
  const synMap: Partial<Record<keyof Palette, string | undefined>> = {
    synKeyword: syn(['keyword.control', 'keyword', 'storage.type', 'storage']),
    synString: syn(['string.quoted', 'string']),
    synNumber: syn(['constant.numeric', 'constant']),
    synComment: syn(['comment.line', 'comment']),
    synFunction: syn(['entity.name.function', 'support.function', 'meta.function-call']),
    synOperator: syn(['keyword.operator']),
    synConstant: syn(['constant.language', 'support.constant', 'constant']),
    synType: syn(['entity.name.type', 'support.type', 'storage.type', 'entity.name.class']),
  };
  for (const [k, v] of Object.entries(synMap)) if (v) (colors as Record<string, string>)[k] = v;
  // Data type colours follow the syntax colours, so values look like their code.
  if (colors.synNumber) colors.typeNumeric = colors.synNumber;
  if (colors.synString) colors.typeText = colors.synString;
  if (colors.synConstant) colors.typeLogical = colors.synConstant;
  if (colors.synType) colors.typeFactor = colors.synType;
  if (colors.synFunction) colors.typeFunction = colors.synFunction;
  const ansiKeys = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
  const ansi = [...ansiKeys.map((k) => `terminal.ansi${k}`), ...ansiKeys.map((k) => `terminal.ansiBright${k}`)].map((k) => c[k] && normalizeColor(c[k], bg));
  const fixed = ensureContrast(type, colors);
  return {
    id: `vscode-${slug(json?.name ?? fallbackName)}`,
    name: json?.name ?? fallbackName,
    type,
    colors: fixed.colors,
    ansi: ansi.every(Boolean) ? (ansi as string[]) : undefined,
    author: json?.author,
    source: 'vscode',
    adjusted: fixed.adjusted,
  };
}

export const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';

const PALETTE_KEYS = new Set(Object.keys(palettes.dark));

/** Read a theme file: DataForge format or a VS Code colour theme. */
export function parseThemeFile(text: string, fileName = 'theme'): CustomTheme {
  const json = parseJsonc(text);
  const name = fileName.replace(/\.(dftheme\.)?json$/i, '');
  if (json?.format === THEME_FORMAT) {
    const type: ThemeMode = json.type === 'light' ? 'light' : 'dark';
    const colors: Partial<Palette> = {};
    for (const [k, v] of Object.entries(json.colors ?? {})) {
      if (!PALETTE_KEYS.has(k)) continue;
      if (k === 'chart') {
        if (Array.isArray(v) && v.every((x) => typeof x === 'string' && normalizeColor(x))) colors.chart = v as string[];
      } else if (k === 'shadowColor') {
        if (typeof v === 'string' && /^\d+ \d+% \d+%$/.test(v)) colors.shadowColor = v;
      } else if (typeof v === 'string' && normalizeColor(v)) {
        (colors as Record<string, string>)[k] = v;
      }
    }
    const fixed = ensureContrast(type, colors);
    return {
      id: `theme-${slug(json.name ?? name)}`,
      name: String(json.name ?? name),
      type,
      colors: fixed.colors,
      ansi: Array.isArray(json.ansi) && json.ansi.length === 16 && json.ansi.every((x: unknown) => typeof x === 'string' && normalizeColor(x)) ? json.ansi : undefined,
      author: typeof json.author === 'string' ? json.author : undefined,
      source: 'file',
      adjusted: fixed.adjusted,
    };
  }
  if (json && (json.colors || json.tokenColors)) return fromVSCode(json, name);
  throw new Error('not a DataForge or VS Code colour theme');
}

/** The full palette of a theme, as a shareable DataForge theme file. */
export function serializeTheme(name: string, type: ThemeMode, overrides: Partial<Palette>, ansi?: string[], author?: string): string {
  return JSON.stringify({ format: THEME_FORMAT, name, type, author, colors: { ...palettes[type], ...overrides }, ansi }, null, 2) + '\n';
}
