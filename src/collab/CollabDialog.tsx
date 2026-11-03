/** "Share this project" / "Join a session" dialog. */
import { AlertTriangle, LogIn, Share2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../app/SettingsDialog';
import { useUi } from '../app/uiStore';
import { Button, IconButton } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { revealPanel } from '../workbench/layout';
import { joinSession, startHosting } from './collab';
import { useCollabPrefs } from './collabStore';
import { parseInvitation, ROLES, type Role } from './protocol';

export function CollabDialog() {
  const { t } = useTranslation();
  const mode = useUi((s) => s.collabDialog);
  const prefs = useCollabPrefs();
  const [name, setName] = useState(prefs.name);
  const [lan, setLan] = useState(prefs.lan);
  const [role, setRole] = useState<Role>(prefs.defaultRole);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useFocusTrap(!!mode);
  const close = () => useUi.setState({ collabDialog: null });

  useEffect(() => {
    if (!mode) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  if (!mode) return null;
  const host = mode === 'host';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('collab.err.name'));
    if (!host && !parseInvitation(invite)) return setError(t('collab.badInvitation'));
    setBusy(true);
    try {
      const ok = host ? !!(await startHosting({ name: name.trim(), lan, defaultRole: role })) : await joinSession(invite, name.trim());
      if (ok) {
        close();
        revealPanel('collab', { focus: false });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="df-overlay" onMouseDown={close}>
      <div ref={ref} className="df-dialog df-collab-dialog" role="dialog" aria-modal="true" aria-labelledby="df-collab-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-dialog__header">
          <h2 id="df-collab-title">{host ? t('collab.shareProject') : t('collab.joinSession')}</h2>
          <IconButton icon={X} label={t('common.close')} onClick={close} />
        </div>
        <form className="df-dialog__body df-collab-dialog__form" onSubmit={(e) => void submit(e)} noValidate>
          <p className="df-collab__muted">{host ? t('collab.shareIntro') : t('collab.joinIntro')}</p>
          {!host && (
            <div className="df-remote__field">
              <label htmlFor="df-collab-inv">{t('collab.invitation')}</label>
              <input
                id="df-collab-inv"
                className="df-input"
                value={invite}
                placeholder="dataforge://join/192.168.1.20:41234/…"
                spellCheck={false}
                onChange={(e) => setInvite(e.target.value)}
                data-autofocus
              />
            </div>
          )}
          <div className="df-remote__field">
            <label htmlFor="df-collab-name">{t('collab.yourName')}</label>
            <input id="df-collab-name" className="df-input" value={name} maxLength={40} placeholder={t('collab.namePlaceholder')} onChange={(e) => setName(e.target.value)} data-autofocus={host ? true : undefined} />
          </div>
          {host && (
            <>
              <fieldset className="df-collab-dialog__choice">
                <legend>{t('collab.reach')}</legend>
                <label>
                  <input type="radio" name="reach" checked={!lan} onChange={() => setLan(false)} />
                  <span>
                    <strong>{t('collab.reachLocal')}</strong>
                    <small>{t('collab.reachLocalHint')}</small>
                  </span>
                </label>
                <label>
                  <input type="radio" name="reach" checked={lan} onChange={() => setLan(true)} />
                  <span>
                    <strong>{t('collab.reachLan')}</strong>
                    <small>{t('collab.reachLanHint')}</small>
                  </span>
                </label>
              </fieldset>
              {lan && (
                <p className="df-collab-dialog__warn" role="note">
                  <AlertTriangle size={14} aria-hidden /> {t('collab.lanWarning')}
                </p>
              )}
              <fieldset className="df-collab-dialog__choice">
                <legend>{t('collab.defaultRole')}</legend>
                {ROLES.map((r) => (
                  <label key={r}>
                    <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                    <span>
                      <strong>{t(`collab.role.${r}`)}</strong>
                      <small>{t(`collab.roleHint.${r}`)}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {error && (
            <p className="df-remote__error" role="alert">
              {error}
            </p>
          )}
          <div className="df-remote__actions">
            <Button type="button" variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" icon={busy ? undefined : host ? Share2 : LogIn} disabled={busy}>
              {busy && <Spinner size={12} />} {host ? t('collab.start') : t('collab.join')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
