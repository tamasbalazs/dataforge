import { AlertCircle, FolderOpen, Package, Palette, Puzzle, RefreshCw, Shield, SquareTerminal, Trash2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { addDevFolder, enableExtension, installFromPackage, loadExtensions, uninstallExtension, useExtensions, type InstalledExtension } from '../../extensions/extensionHost';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Spinner } from '../../ui/Spinner';

function Card({ x }: { x: InstalledExtension }) {
  const { t } = useTranslation();
  const m = x.manifest;
  const status = useExtensions((s) => (m ? s.status[m.id] : undefined));
  const error = useExtensions((s) => (m ? s.errors[m.id] : ''));
  const enabled = useExtensions((s) => (m ? s.enabled[m.id] !== false && status !== 'needsConsent' : false));
  if (!m) {
    return (
      <li className="df-ext is-broken">
        <div className="df-ext__head">
          <AlertCircle size={16} aria-hidden className="df-ext__icon" />
          <div className="df-ext__title">
            <strong>{x.dir.split(/[\\/]/).pop()}</strong>
            <span className="df-ext__muted">{t('extensions.invalid')}</span>
          </div>
          <IconButton icon={Trash2} size="sm" label={t('extensions.uninstall')} onClick={() => void uninstallExtension(x)} />
        </div>
        <pre className="df-ext__error">{x.errors.join('\n')}</pre>
      </li>
    );
  }
  const c = m.contributes;
  return (
    <li className={`df-ext is-${status ?? 'disabled'}`}>
      <div className="df-ext__head">
        <Puzzle size={16} aria-hidden className="df-ext__icon" />
        <div className="df-ext__title">
          <strong>{m.name}</strong>
          <span className="df-ext__muted">
            {m.version} · {m.author ?? m.id}
            {x.dev && <span className="df-ext__badge">{t('extensions.dev')}</span>}
          </span>
        </div>
        {status === 'loading' && <Spinner size={12} />}
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t('extensions.enabledFor', { name: m.name })}
          title={enabled ? t('extensions.disable') : t('extensions.enable')}
          className={`df-switch ${enabled ? 'is-on' : ''}`}
          onClick={() => void enableExtension(m.id, !enabled)}
        >
          <span />
        </button>
        <IconButton icon={Trash2} size="sm" label={x.dev ? t('extensions.removeDev') : t('extensions.uninstall')} onClick={() => void uninstallExtension(x)} />
      </div>
      {m.description && <p className="df-ext__desc">{m.description}</p>}
      <div className="df-ext__chips">
        {m.permissions.map((p) => (
          <span key={p} className={`df-ext__chip is-perm ${p === 'network' ? 'is-risky' : ''}`} title={t(`extensions.perm.${p}`)}>
            <Shield size={11} aria-hidden /> {t(`extensions.permShort.${p}`)}
          </span>
        ))}
        {c.commands.length > 0 && (
          <span className="df-ext__chip">
            <SquareTerminal size={11} aria-hidden /> {t('extensions.commands', { count: c.commands.length })}
          </span>
        )}
        {c.panels.length > 0 && <span className="df-ext__chip">{t('extensions.panels', { count: c.panels.length })}</span>}
        {c.snippets.length > 0 && <span className="df-ext__chip">{t('extensions.snippets', { count: c.snippets.length })}</span>}
        {c.themes.length > 0 && (
          <span className="df-ext__chip">
            <Palette size={11} aria-hidden /> {t('extensions.themes', { count: c.themes.length })}
          </span>
        )}
      </div>
      {status === 'needsConsent' && (
        <div className="df-ext__notice">
          <Shield size={13} aria-hidden /> {t('extensions.needsConsent')}
          <Button size="sm" variant="secondary" onClick={() => void enableExtension(m.id, true)}>
            {t('extensions.review')}
          </Button>
        </div>
      )}
      {status === 'error' && error && <pre className="df-ext__error">{error}</pre>}
    </li>
  );
}

export function ExtensionsPanel() {
  const { t } = useTranslation();
  const list = useExtensions((s) => s.list);
  const loaded = useExtensions((s) => s.loaded);
  return (
    <div className="df-exts">
      <div className="df-panel-toolbar">
        <Button size="sm" variant="primary" icon={Package} onClick={() => void installFromPackage()}>
          {t('extensions.install')}
        </Button>
        <IconButton icon={FolderOpen} size="sm" label={t('extensions.loadDev')} onClick={() => void addDevFolder()} />
        <span className="df-panel-toolbar__spacer" />
        <IconButton icon={RefreshCw} size="sm" label={t('extensions.reload')} onClick={() => void loadExtensions()} />
      </div>
      <div className="df-exts__body">
        {!loaded ? (
          <Spinner size={14} />
        ) : !list.length ? (
          <EmptyState icon={Puzzle} title={t('extensions.emptyTitle')}>
            <p>{t('extensions.emptyBody')}</p>
            <Button size="sm" variant="secondary" icon={Wrench} onClick={() => void addDevFolder()}>
              {t('extensions.loadDev')}
            </Button>
          </EmptyState>
        ) : (
          <ul className="df-exts__list">
            {list.map((x) => (
              <Card key={x.manifest?.id ?? x.dir} x={x} />
            ))}
          </ul>
        )}
        <p className="df-exts__note">
          <Shield size={12} aria-hidden /> {t('extensions.sandboxNote')}
        </p>
      </div>
    </div>
  );
}
