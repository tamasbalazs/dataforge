import { describe, expect, it } from 'vitest';
import { authorize, engineSatisfied, parseSnippets, validateManifest } from './manifest';

const good = {
  id: 'dataforge.data-summary',
  name: 'Adat-összefoglaló',
  version: '1.0.0',
  main: 'main.js',
  permissions: ['editor', 'kernel'],
  engines: { dataforge: '>=0.1' },
  contributes: {
    commands: [{ id: 'describe', title: 'Összefoglalás', keybinding: 'Mod+Alt+D' }],
    panels: [{ id: 'summary', title: 'Összefoglaló' }],
    themes: [{ path: 'themes/solarized.json' }],
    snippets: [{ language: 'r', path: 'snippets/r.json' }],
  },
};

describe('extension manifest', () => {
  it('accepts a complete manifest', () => {
    const { manifest, errors } = validateManifest(good);
    expect(errors).toEqual([]);
    expect(manifest!.contributes.commands[0].keybinding).toBe('Mod+Alt+D');
  });

  it('reports every problem', () => {
    const { errors } = validateManifest({
      id: 'NoDot',
      version: '1',
      main: '../escape.js',
      permissions: ['root'],
      contributes: { commands: [{ id: '', title: 'x' }], themes: [{ path: '/etc/passwd' }], snippets: [{ language: 'julia', path: 'a.json' }] },
    });
    expect(errors.join('\n')).toMatch(/id must look like/);
    expect(errors.join('\n')).toMatch(/name is required/);
    expect(errors.join('\n')).toMatch(/version must be semantic/);
    expect(errors.join('\n')).toMatch(/main must be a relative/);
    expect(errors.join('\n')).toMatch(/unknown permission "root"/);
    expect(errors.join('\n')).toMatch(/invalid theme path/);
    expect(errors.join('\n')).toMatch(/invalid snippets entry/);
  });

  it('requires main for commands and checks the engine version', () => {
    expect(validateManifest({ ...good, main: undefined }).errors.join()).toMatch(/need a "main"/);
    expect(validateManifest({ ...good, engines: { dataforge: '>=2.0' } }).errors.join()).toMatch(/requires DataForge/);
    expect(engineSatisfied('^0.1', '0.1.5')).toBe(true);
    expect(engineSatisfied('^0.1', '0.2.0')).toBe(false);
    expect(engineSatisfied('^1.2', '1.9.0')).toBe(true);
    expect(engineSatisfied('*', '9.9.9')).toBe(true);
  });
});

describe('API permissions', () => {
  const m = validateManifest(good).manifest!;
  it('gates methods by permission and declaration', () => {
    expect(authorize(m, 'editor.getSelection', [])).toBeNull();
    expect(authorize(m, 'kernel.evaluate', ['r', 'x'])).toBeNull();
    expect(authorize(m, 'kernel.evaluate', ['sh', 'rm -rf /'])).toMatch(/language/);
    expect(authorize(m, 'workspace.readFile', ['data.csv'])).toMatch(/workspace/);
    expect(authorize(m, 'commands.register', ['describe'])).toBeNull();
    expect(authorize(m, 'commands.register', ['secret'])).toMatch(/not declared/);
    expect(authorize(m, 'panels.setHtml', ['other', '<b>'])).toMatch(/not declared/);
    expect(authorize(m, 'host.invoke', [])).toMatch(/unknown API method/);
    const ws = { ...m, permissions: ['workspace' as const] };
    expect(authorize(ws, 'workspace.readFile', ['../../etc/passwd'])).toMatch(/relative/);
    expect(authorize(ws, 'workspace.readFile', ['data/a.csv'])).toBeNull();
  });
});

describe('snippets', () => {
  it('reads VS Code snippet files', () => {
    const s = parseSnippets({ 'ggplot alap': { prefix: ['ggp', 'gg'], body: ['ggplot(${1:df}, aes(${2:x}, ${3:y})) +', '  geom_point()$0'], description: 'ggplot' }, broken: { prefix: 'x' } });
    expect(s.map((x) => x.prefix)).toEqual(['ggp', 'gg']);
    expect(s[0].body).toBe('ggplot(${1:df}, aes(${2:x}, ${3:y})) +\n  geom_point()$0');
  });
});
