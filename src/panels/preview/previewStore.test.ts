import { describe, expect, it } from 'vitest';
import { buildRenderStep, decorateHtml, errorSummary, previewEngine, stemOf, stripAnsi } from './previewStore';

describe('preview rendering', () => {
  it('picks the engine like RStudio does', () => {
    expect(previewEngine('/p/a.qmd', { quarto: true, r: true })).toBe('quarto');
    expect(previewEngine('/p/a.qmd', { quarto: false, r: true })).toBeNull();
    expect(previewEngine('/p/a.Rmd', { quarto: true, r: true })).toBe('rmarkdown');
    expect(previewEngine('/p/a.Rmd', { quarto: true, r: false })).toBe('quarto');
    expect(previewEngine('/p/a.R', { quarto: true, r: true })).toBeNull();
    expect(stemOf('/p/riport.v2.qmd')).toBe('riport.v2');
  });

  it('renders Quarto into the scratch folder with the project interpreters', () => {
    const st = buildRenderStep('quarto', '/p/a.qmd', '/tmp/out', { quarto: '/bin/quarto', r: '/usr/bin/R', python: '/p/.venv/bin/python' });
    expect(st.program).toBe('/bin/quarto');
    expect(st.args).toEqual(['render', '/p/a.qmd', '--to', 'html', '--output-dir', '/tmp/out', '-M', 'embed-resources:true']);
    expect(st.env).toEqual({ QUARTO_PYTHON: '/p/.venv/bin/python', RETICULATE_PYTHON: '/p/.venv/bin/python', QUARTO_R: '/usr/bin/R' });
  });

  it('renders R Markdown with rmarkdown::render and quotes paths safely', () => {
    const st = buildRenderStep('rmarkdown', 'C:\\Users\\Ádám\\"x".Rmd', 'C:\\Temp\\out', { quarto: null, r: 'C:\\R\\bin\\R.exe', python: null });
    expect(st.program).toBe('C:\\R\\bin\\R.exe');
    const code = st.args[st.args.length - 1];
    expect(code).toContain('rmarkdown::render("C:/Users/Ádám/\\"x\\".Rmd", output_format = "html_document", output_dir = "C:/Temp/out"');
    expect(st.env).toEqual({ QUARTO_R: 'C:\\R\\bin\\R.exe' });
  });

  it('injects the scroll/link bridge into the page head', () => {
    const out = decorateHtml('<html><head><title>x</title></head><body></body></html>', 420);
    expect(out.indexOf('<script>')).toBe('<html><head>'.length);
    expect(out).toContain('var y=420');
    expect(decorateHtml('<p>bare</p>', 0).endsWith('<p>bare</p>')).toBe(true);
  });

  it('cleans the render log and finds the explaining line', () => {
    expect(stripAnsi('\u001b[31mERROR\u001b[39m: bad')).toBe('ERROR: bad');
    const log = ['processing file', 'ERROR: YAMLException: bad indentation of a mapping entry (2:12)', '', ' 2 | title: "x" 2024', '----------------^', '', 'Stack trace:', '    at foo (file.js:1:1)'];
    expect(errorSummary(log)).toBe('ERROR: YAMLException: bad indentation of a mapping entry (2:12)\n\n 2 | title: "x" 2024\n----------------^');
    expect(errorSummary(['Quitting from lines 8-10 [unnamed-chunk-1] (a.Rmd)', 'Error in `foo()`:'])).toContain('Quitting from lines 8-10');
    expect(errorSummary(['all good'])).toBeNull();
  });
});
