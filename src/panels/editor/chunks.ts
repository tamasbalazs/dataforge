/**
 * Code chunks in literate documents (Quarto .qmd, R Markdown .Rmd, .md):
 *   ```{r label, echo=FALSE}   ```{python}   ```r
 */
import type { Lang } from '../../core/host';

export interface Chunk {
  lang: Lang;
  /** 0-based line of the opening fence. */
  header: number;
  /** 0-based first and last code line (start > end for an empty chunk). */
  start: number;
  end: number;
  label: string | null;
  /** `{stan output.var="m"}`: compiled from R into the variable `outputVar`. */
  stan?: { outputVar: string | null };
}

const OPEN = /^\s*(`{3,}|~{3,})\s*\{?\s*([A-Za-z]+)\b([^}]*)\}?\s*$/;
const LANGS: Record<string, Lang> = { r: 'r', python: 'python', py: 'python' };

export const isLiterate = (path: string | null | undefined) => !!path && /\.(qmd|rmd|md|rmarkdown)$/i.test(path);

export function findChunks(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    const fence = m[1];
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    const engine = m[2].toLowerCase();
    const lang = engine === 'stan' ? 'r' : LANGS[engine];
    // Only `{r}` style chunks are executable in Quarto/knitr; plain ```r too in .md.
    if (lang && (engine !== 'stan' || m[0].includes('{'))) {
      const opts = m[3].trim().replace(/^,/, '').trim();
      const label = /^([\w.-]+)\s*(,|$)/.exec(opts)?.[1] ?? /#\|\s*label:\s*(\S+)/.exec(lines[i + 1] ?? '')?.[1] ?? null;
      const chunk: Chunk = { lang, header: i, start: i + 1, end: j - 1, label: label && !label.includes('=') ? label : null };
      if (engine === 'stan') {
        const inline = /output\.var\s*=\s*["']([^"']+)["']/.exec(opts)?.[1];
        const yaml = lines.slice(i + 1, j).map((l) => /^\s*#\|\s*output\.var:\s*["']?([\w.]+)["']?/.exec(l)?.[1]).find(Boolean);
        chunk.stan = { outputVar: inline ?? yaml ?? null };
      }
      out.push(chunk);
    }
    i = j;
  }
  return out;
}

/** The chunk containing a 0-based line (header and closing fence included). */
export function chunkAt(chunks: Chunk[], line: number): Chunk | null {
  return chunks.find((c) => line >= c.header && line <= c.end + 1) ?? null;
}

/** Chunk code without Quarto `#|` option lines. */
export function chunkCode(lines: string[], c: Chunk): string {
  return lines
    .slice(c.start, c.end + 1)
    .filter((l) => !/^\s*#\|/.test(l))
    .join('\n');
}

const rStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * R code that compiles a `{stan}` chunk the way knitr would when rendering:
 * with cmdstanr when the document registers its knitr engine, else rstan.
 */
export function stanChunkR(code: string, outputVar: string | null, docLines: string[]): string {
  if (!outputVar) return 'stop("Stan chunks need output.var, e.g. ```{stan output.var = \\"model\\"}")';
  if (!/^[A-Za-z.][\w.]*$/.test(outputVar)) return `stop(${rStr(`invalid output.var: ${outputVar}`)})`;
  const cmdstanr = docLines.some((l) => /cmdstanr::register_knitr_engine\s*\(|register_knitr_engine\s*\(/.test(l));
  return cmdstanr
    ? `${outputVar} <- cmdstanr::cmdstan_model(cmdstanr::write_stan_file(${rStr(code)}))`
    : `${outputVar} <- rstan::stan_model(model_code = ${rStr(code)})`;
}
