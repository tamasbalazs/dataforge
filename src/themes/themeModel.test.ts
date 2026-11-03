import { describe, expect, it } from 'vitest';
import { contrastPairs, contrastRatio, palettes, type Palette } from '../design/tokens';
import { ensureContrast, fromVSCode, mix, normalizeColor, parseJsonc, parseThemeFile, scopeColor, serializeTheme } from './themeModel';

const MONOKAI_LIKE = `{
  // a VS Code colour theme, JSONC
  "name": "Monokai Próba",
  "type": "dark",
  "colors": {
    "editor.background": "#272822",
    "editor.foreground": "#F8F8F2",
    "sideBar.background": "#1e1f1c",
    "focusBorder": "#99947c",
    "button.background": "#75715E",
    "editorError.foreground": "#F92672",
    "editor.lineHighlightBackground": "#3e3d3280", /* translucent */
    "terminal.ansiBlack": "#333333", "terminal.ansiRed": "#C4265E", "terminal.ansiGreen": "#86B42B", "terminal.ansiYellow": "#B3B42B",
    "terminal.ansiBlue": "#6A7EC8", "terminal.ansiMagenta": "#8C6BC8", "terminal.ansiCyan": "#56ADBC", "terminal.ansiWhite": "#E3E3DD",
    "terminal.ansiBrightBlack": "#666666", "terminal.ansiBrightRed": "#F92672", "terminal.ansiBrightGreen": "#A6E22E", "terminal.ansiBrightYellow": "#E2E22E",
    "terminal.ansiBrightBlue": "#819AFF", "terminal.ansiBrightMagenta": "#AE81FF", "terminal.ansiBrightCyan": "#66D9EF", "terminal.ansiBrightWhite": "#F8F8F2",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#88846f" } },
    { "scope": ["string"], "settings": { "foreground": "#E6DB74" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#AE81FF" } },
    { "scope": "keyword, storage.type", "settings": { "foreground": "#F92672" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#A6E22E" } },
  ],
}`;

const allPass = (type: 'dark' | 'light', colors: Partial<Palette>) => {
  const p = { ...palettes[type], ...colors } as Palette;
  return contrastPairs.filter(([fg, bg]) => contrastRatio(p[fg] as string, p[bg] as string) < 4.5).map(([fg, bg]) => `${fg}/${bg}`);
};

describe('colour helpers', () => {
  it('normalizes alpha colours over a background', () => {
    expect(normalizeColor('#3e3d3280', '#272822')).toBe('#33332A');
    expect(normalizeColor('#abc')).toBe('#AABBCC');
    expect(normalizeColor('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(normalizeColor('nonsense')).toBeNull();
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('parses JSONC and picks the most specific scope', () => {
    expect(parseJsonc('{ "a": 1, // x\n "b": [1,2,], /* y */ }')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonc('{ "url": "http://x//y" }')).toEqual({ url: 'http://x//y' });
    const rules = [{ scope: 'keyword', settings: { foreground: '#111111' } }, { scope: 'keyword.control', settings: { foreground: '#222222' } }];
    expect(scopeColor(rules, ['keyword.control.flow'])).toBe('#222222');
    expect(scopeColor(rules, ['keyword.other'])).toBe('#111111');
  });
});

describe('VS Code import', () => {
  const t = fromVSCode(parseJsonc(MONOKAI_LIKE));

  it('maps editor, sidebar, syntax and terminal colours', () => {
    expect(t.type).toBe('dark');
    expect(t.name).toBe('Monokai Próba');
    expect(t.colors.surface1).toBe('#272822');
    expect(t.colors.surface0).toBe('#1E1F1C');
    expect(t.colors.textPrimary).toBe('#F8F8F2');
    expect(t.colors.synString).toBe('#E6DB74');
    // Monokai pink is ~4:1 on its background, so it is lifted (and reported).
    expect(t.colors.synKeyword === '#F92672' || t.adjusted?.includes('synKeyword')).toBe(true);
    expect(t.colors.typeNumeric).toBe(t.colors.synNumber);
    expect(t.ansi).toHaveLength(16);
  });

  it('fixes colours that would fail WCAG AA, and says which', () => {
    expect(allPass('dark', t.colors)).toEqual([]);
    expect(t.adjusted).toContain('synComment'); // #88846f on #272822 is ~4.1:1
  });

  it('detects light themes from the background when type is missing', () => {
    expect(fromVSCode({ colors: { 'editor.background': '#fdf6e3', 'editor.foreground': '#657b83' } }).type).toBe('light');
  });
});

describe('DataForge theme files', () => {
  it('round-trips through the shareable format', () => {
    const text = serializeTheme('Saját', 'light', { accent: '#B4235A' }, undefined, 'Anna');
    const t = parseThemeFile(text, 'sajat.dftheme.json');
    expect(t.name).toBe('Saját');
    expect(t.type).toBe('light');
    expect(t.colors.accent).toBe('#B4235A');
    expect(t.author).toBe('Anna');
    expect(allPass('light', t.colors)).toEqual([]);
  });

  it('ignores unknown keys and invalid colours', () => {
    const t = parseThemeFile(JSON.stringify({ format: 'dataforge-theme/1', name: 'x', type: 'dark', colors: { accent: 'javascript:alert(1)', evil: '#FFF', textPrimary: '#FFFFFF' } }));
    expect(t.colors.accent).toBeUndefined();
    expect((t.colors as any).evil).toBeUndefined();
    expect(t.colors.textPrimary).toBe('#FFFFFF');
  });

  it('rejects files that are not themes', () => {
    expect(() => parseThemeFile('{"hello": 1}')).toThrow();
  });

  it('raises low-contrast text', () => {
    const { colors, adjusted } = ensureContrast('dark', { textMuted: '#2A2F39' });
    expect(adjusted).toContain('textMuted');
    expect(contrastRatio(colors.textMuted!, palettes.dark.surface2)).toBeGreaterThanOrEqual(4.5);
  });
});
