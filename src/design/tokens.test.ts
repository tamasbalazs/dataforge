import { describe, expect, it } from 'vitest';
import { contrastPairs, contrastRatio, cssVariables, palettes, parseColor, plotTheme } from './tokens';

/** Variables set inline by components (not design tokens). */
const COMPONENT_VARS = ['--tone', '--rownum-w'];

describe('design tokens', () => {
  it('computes known contrast ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('parses hex and rgba colours', () => {
    expect(parseColor('#abc')).toEqual([170, 187, 204, 1]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode} theme meets WCAG AA for all text pairs`, () => {
      const p = palettes[mode];
      const failures = contrastPairs
        .map(([fg, bg]) => ({ pair: `${fg}/${bg}`, ratio: contrastRatio(p[fg] as string, p[bg] as string) }))
        .filter((r) => r.ratio < 4.5);
      expect(failures).toEqual([]);
    });

    it(`${mode} theme has both themes with identical token sets`, () => {
      expect(Object.keys(cssVariables(mode)).sort()).toEqual(Object.keys(cssVariables('light')).sort());
    });
  }

  it('every CSS variable referenced by the stylesheets is defined', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(`${__dirname}/global.css`, 'utf8');
    const defined = new Set(Object.keys(cssVariables('dark')));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]).filter((v) => !v.startsWith('--dv-') && !COMPONENT_VARS.includes(v)));
    expect([...used].filter((v) => !defined.has(v))).toEqual([]);
  });

  it('applies overrides (custom themes)', () => {
    expect(cssVariables('dark', { accent: '#FF0000' })['--accent']).toBe('#FF0000');
  });

  it('derives plot colours from the palette', () => {
    const t = plotTheme('dark');
    expect(t.bg).toBe(palettes.dark.surface1);
    expect(t.palette.length).toBeGreaterThanOrEqual(6);
  });
});
