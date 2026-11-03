/** "Remote hosts" dialog: saved SSH hosts, connection state and a folder picker. */
import { AlertCircle, ArrowUp, Check, Folder, FolderOpen, Pencil, Plug, Plus, Server, Trash2, Unplug, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '../app/uiStore';
import { useFocusTrap } from '../app/SettingsDialog';
import { ask } from '../core/dialog';
import { host, type FsEntry, type RemoteProfile } from '../core/host';
import { formatRemote, parseRemote } from '../core/paths';
import { getSettings, useSettings } from '../core/settings';
import { LANG_LABEL } from '../kernels/kernels';
import { Button, IconButton } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import {
  connect,
  deleteProfile,
  disconnect,
  newProfileId,
  openRemoteFolder,
  profileLabel,
  resolveRemoteFolder,
  saveProfile,
  splitTarget,
  useRemote,
  validateProfile,
  type ProfileProblem,
} from './remoteStore';

const emptyProfile = (): RemoteProfile => ({ id: '', name: '', host: '', user: '', port: null, identityFile: '', folder: '' });

function ProfileForm({ initial, onDone }: { initial: RemoteProfile; onDone: (saved: RemoteProfile | null) => void }) {
  const { t } = useTranslation();
  const [p, setP] = useState<RemoteProfile>(initial);
  const [problems, setProblems] = useState<ProfileProblem[]>([]);
  const isNew = !initial.id;
  const set = (patch: Partial<RemoteProfile>) => setP((x) => ({ ...x, ...patch }));
  const err = (field: ProfileProblem['field']) => problems.find((x) => x.field === field);

  const onHostBlur = () => {
    // "ana@lab.example.org:2222" pasted into the host field.
    if (!/[@:]/.test(p.host)) return;
    const s = splitTarget(p.host);
    set({ host: s.host, user: s.user ?? p.user, port: s.port ?? p.port });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean: RemoteProfile = {
      ...p,
      host: p.host.trim(),
      user: p.user?.trim() || null,
      identityFile: p.identityFile?.trim() || null,
      folder: p.folder?.trim() || null,
      name: p.name.trim(),
    };
    const found = validateProfile(clean);
    setProblems(found);
    if (found.length) return;
    const saved = { ...clean, id: clean.id || newProfileId(clean.name || clean.host) };
    saveProfile(saved);
    onDone(saved);
  };

  const field = (key: ProfileProblem['field'] | 'identityFile', label: string, input: React.ReactNode, hint?: string) => {
    const e = key !== 'identityFile' ? err(key) : undefined;
    return (
      <div className="df-remote__field">
        <label htmlFor={`df-remote-${key}`}>{label}</label>
        {input}
        {e ? (
          <p className="df-remote__error" id={`df-remote-${key}-err`} role="alert">
            {t(e.key)}
          </p>
        ) : hint ? (
          <p className="df-field__hint">{hint}</p>
        ) : null}
      </div>
    );
  };

  return (
    <form className="df-remote__form" onSubmit={submit} noValidate>
      <h3>{isNew ? t('remote.newHost') : t('remote.editHost')}</h3>
      {field('name', t('remote.name'), <input id="df-remote-name" className="df-input" value={p.name} placeholder={t('remote.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} data-autofocus />)}
      {field(
        'host',
        t('remote.host'),
        <input
          id="df-remote-host"
          className="df-input"
          value={p.host}
          placeholder="lab.example.org"
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={!!err('host')}
          aria-describedby={err('host') ? 'df-remote-host-err' : undefined}
          onChange={(e) => set({ host: e.target.value })}
          onBlur={onHostBlur}
        />,
        t('remote.hostHint'),
      )}
      <div className="df-remote__row">
        {field('user', t('remote.user'), <input id="df-remote-user" className="df-input" value={p.user ?? ''} placeholder={t('remote.userPlaceholder')} spellCheck={false} autoCapitalize="off" aria-invalid={!!err('user')} onChange={(e) => set({ user: e.target.value })} />)}
        {field(
          'port',
          t('remote.port'),
          <input
            id="df-remote-port"
            className="df-input df-remote__port"
            inputMode="numeric"
            value={p.port ?? ''}
            placeholder="22"
            aria-invalid={!!err('port')}
            onChange={(e) => set({ port: e.target.value.trim() === '' ? null : Number(e.target.value) })}
          />,
        )}
      </div>
      {field('identityFile', t('remote.identity'), <input id="df-remote-identityFile" className="df-input" value={p.identityFile ?? ''} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => set({ identityFile: e.target.value })} />, t('remote.identityHint'))}
      {field('folder', t('remote.folder'), <input id="df-remote-folder" className="df-input" value={p.folder ?? ''} placeholder="~/projektek" spellCheck={false} aria-invalid={!!err('folder')} onChange={(e) => set({ folder: e.target.value })} />)}
      <div className="df-remote__actions">
        <Button type="button" variant="ghost" onClick={() => onDone(null)}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" icon={Check}>
          {t('remote.save')}
        </Button>
      </div>
    </form>
  );
}

/** Browse folders of a connected host and open one as the project. */
function FolderPicker({ id, start }: { id: string; start: string }) {
  const { t } = useTranslation();
  const [path, setPath] = useState(start);
  const [draft, setDraft] = useState(start);
  const [dirs, setDirs] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let live = true;
    setDirs(null);
    setError(null);
    host()
      .fsList(formatRemote(id, path), false)
      .then((list) => live && setDirs(list.filter((e) => e.isDir)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [id, path]);

  const go = (p: string) => {
    setPath(p);
    setDraft(p);
  };
  const up = path === '/' ? null : path.replace(/\/[^/]+\/?$/, '') || '/';
  const open = async () => {
    // Close as soon as the project has switched; kernels keep starting in the background.
    const target = formatRemote(id, path);
    if (getSettings().workdir === target) {
      useUi.setState({ remoteOpen: false });
      return;
    }
    setOpening(true);
    const off = useSettings.subscribe((st, prev) => {
      if (st.workdir === target && prev.workdir !== target) {
        off();
        useUi.setState({ remoteOpen: false });
      }
    });
    try {
      await openRemoteFolder(id, path);
    } finally {
      off();
      setOpening(false);
    }
  };

  return (
    <div className="df-remote__picker">
      <form
        className="df-remote__path"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft.trim() || '/');
        }}
      >
        <label htmlFor="df-remote-path" className="df-sr-only">
          {t('remote.folderPath')}
        </label>
        <IconButton icon={ArrowUp} size="sm" label={t('remote.up')} disabled={!up} onClick={() => up && go(up)} />
        <input id="df-remote-path" className="df-input" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
      </form>
      <ul className="df-remote__dirs" role="listbox" aria-label={t('remote.folders')}>
        {error ? (
          <li className="df-remote__error">{error}</li>
        ) : !dirs ? (
          <li className="df-remote__muted">
            <Spinner size={12} /> {t('remote.loading')}
          </li>
        ) : !dirs.length ? (
          <li className="df-remote__muted">{t('remote.noSubfolders')}</li>
        ) : (
          dirs.map((d) => {
            const p = parseRemote(d.path)!.path;
            return (
              <li key={d.path} role="option" aria-selected={false}>
                <button type="button" onClick={() => go(p)} onDoubleClick={() => go(p)}>
                  <Folder size={14} aria-hidden /> {d.name}
                </button>
              </li>
            );
          })
        )}
      </ul>
      <div className="df-remote__actions">
        <Button variant="primary" icon={opening ? undefined : FolderOpen} disabled={!!error || opening} onClick={() => void open()}>
          {opening && <Spinner size={12} />} {t('remote.openFolder', { path })}
        </Button>
      </div>
    </div>
  );
}

function ProfileDetail({ p, onEdit }: { p: RemoteProfile; onEdit: () => void }) {
  const { t } = useTranslation();
  const conn = useRemote((s) => s.connections[p.id]);
  const workdir = useSettings((s) => s.workdir);
  const isCurrent = parseRemote(workdir)?.id === p.id;
  const target = `${p.user ? `${p.user}@` : ''}${p.host}${p.port ? `:${p.port}` : ''}`;

  const remove = async () => {
    const ok = await ask(t('remote.deleteTitle', { name: profileLabel(p) }), t('remote.deleteBody'), [
      { id: 'delete', label: t('remote.delete'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (ok === 'delete') await deleteProfile(p.id);
  };

  return (
    <div className="df-remote__detail">
      <div className="df-remote__detail-head">
        <Server size={18} aria-hidden className="df-remote__icon" />
        <div className="df-remote__title">
          <strong>{profileLabel(p)}</strong>
          <span className="df-remote__muted">{target}</span>
        </div>
        <IconButton icon={Pencil} size="sm" label={t('remote.editHost')} onClick={onEdit} />
        <IconButton icon={Trash2} size="sm" label={t('remote.delete')} onClick={() => void remove()} />
      </div>

      {!conn || conn.status === 'error' ? (
        <div className="df-remote__state">
          {conn?.error && (
            <p className="df-remote__error" role="alert">
              <AlertCircle size={14} aria-hidden /> {conn.error}
            </p>
          )}
          <Button variant="primary" icon={Plug} onClick={() => void connect(p.id, { quiet: true })}>
            {conn?.error ? t('remote.retry') : t('remote.connect')}
          </Button>
        </div>
      ) : conn.status === 'connecting' ? (
        <div className="df-remote__state" aria-live="polite">
          <Spinner size={14} /> {t('remote.connecting', { host: p.host })}
        </div>
      ) : (
        <>
          <div className="df-remote__info">
            <span className="df-dot df-dot--idle" aria-hidden />
            <span>{t('remote.connectedTo', { host: conn.info?.hostname || p.host, os: conn.info?.os || '?' })}</span>
            <span className="df-panel-toolbar__spacer" />
            <Button size="sm" variant="ghost" icon={Unplug} onClick={() => void disconnect(p.id)}>
              {t('remote.disconnect')}
            </Button>
          </div>
          <ul className="df-remote__interps" aria-label={t('remote.interpreters')}>
            {(conn.info?.interpreters ?? []).map((i) => (
              <li key={i.path} className={i.hasKernel ? '' : 'is-missing'}>
                <strong>
                  {LANG_LABEL[i.lang]} {i.version}
                </strong>
                <code>{i.path}</code>
                {i.hasKernel ? (
                  <span className="df-remote__ok">
                    <Check size={12} aria-hidden /> {t('remote.kernelOk')}
                  </span>
                ) : (
                  <span className="df-remote__muted" title={i.installHint ?? ''}>
                    {t('remote.kernelMissing')}
                  </span>
                )}
              </li>
            ))}
            {!conn.info?.interpreters.length && <li className="df-remote__muted">{t('remote.noInterpreters')}</li>}
          </ul>
          {isCurrent && <p className="df-field__hint">{t('remote.isCurrent', { path: parseRemote(workdir)!.path })}</p>}
          <FolderPicker key={p.id} id={p.id} start={resolveRemoteFolder(isCurrent ? parseRemote(workdir)!.path : p.folder, conn.info?.home ?? '/')} />
        </>
      )}
    </div>
  );
}

export function RemoteDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.remoteOpen);
  const list = useSettings((s) => s.remoteProfiles ?? []);
  const connections = useRemote((s) => s.connections);
  const workdir = useSettings((s) => s.workdir);
  const [selected, setSelected] = useState<string | null>(null);
  // With no saved hosts the form shows right away (and gets the initial focus).
  const [editing, setEditing] = useState<RemoteProfile | null>(() => (list.length ? null : emptyProfile()));
  const ref = useFocusTrap(open);
  const close = () => useUi.setState({ remoteOpen: false });

  useEffect(() => {
    if (!open) return;
    const cur = parseRemote(workdir)?.id;
    setSelected((s) => (s && list.some((p) => p.id === s) ? s : (cur ?? list[0]?.id ?? null)));
    setEditing(list.length ? null : emptyProfile());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = useMemo(() => list.find((p) => p.id === selected) ?? null, [list, selected]);
  if (!open) return null;

  return (
    <div className="df-overlay" onMouseDown={close}>
      <div ref={ref} className="df-dialog df-remote" role="dialog" aria-modal="true" aria-labelledby="df-remote-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-dialog__header">
          <h2 id="df-remote-title">{t('remote.title')}</h2>
          <IconButton icon={X} label={t('common.close')} onClick={close} />
        </div>
        <div className="df-remote__body">
          <nav className="df-remote__list" aria-label={t('remote.hosts')}>
            <ul>
              {list.map((p) => {
                const st = connections[p.id]?.status;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`df-remote__host ${p.id === selected && !editing ? 'is-active' : ''}`}
                      aria-current={p.id === selected && !editing ? 'true' : undefined}
                      onClick={() => (setSelected(p.id), setEditing(null))}
                    >
                      {st === 'connecting' ? <Spinner size={10} /> : <span className={`df-dot df-dot--${st === 'connected' ? 'idle' : st === 'error' ? 'error' : 'off'}`} aria-hidden />}
                      <span className="df-remote__host-name">{profileLabel(p)}</span>
                      <span className="df-sr-only">{st ? t(`remote.status.${st}`) : t('remote.status.off')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setEditing(emptyProfile())}>
              {t('remote.addHost')}
            </Button>
          </nav>
          <div className="df-remote__main">
            {editing ? (
              <ProfileForm
                key={editing.id || 'new'}
                initial={editing}
                onDone={(saved) => {
                  setEditing(null);
                  if (saved) {
                    setSelected(saved.id);
                    // A changed target invalidates the old connection.
                    if (connections[saved.id]) void disconnect(saved.id).then(() => connect(saved.id, { quiet: true }));
                    else void connect(saved.id, { quiet: true });
                  }
                }}
              />
            ) : current ? (
              <ProfileDetail p={current} onEdit={() => setEditing(current)} />
            ) : (
              <p className="df-remote__muted">{t('remote.emptyBody')}</p>
            )}
          </div>
        </div>
        <p className="df-remote__note">{t('remote.note')}</p>
      </div>
    </div>
  );
}
