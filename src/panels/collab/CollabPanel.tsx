/** Session panel: invitation, participants (roles, follow, remove) and chat. */
import { Copy, Eye, EyeOff, LogIn, LogOut, Send, Share2, UserX, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '../../app/uiStore';
import { endSession, kickPeer, markChatRead, sendChat, setFollow, setPeerRole } from '../../collab/collab';
import { useCollab } from '../../collab/collabStore';
import { readableText, ROLES, type Peer, type Role } from '../../collab/protocol';
import { ask } from '../../core/dialog';
import { toast } from '../../core/toast';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Spinner } from '../../ui/Spinner';

function PeerRow({ p, hosting, isMe }: { p: Peer; hosting: boolean; isMe: boolean }) {
  const { t } = useTranslation();
  const follow = useCollab((s) => s.follow);
  const where = useCollab((s) => s.presence[p.id]?.doc);
  const following = follow === p.id;
  return (
    <li className="df-collab__peer">
      <span className="df-collab__avatar" style={{ background: p.color, color: readableText(p.color) }} aria-hidden>
        {p.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="df-collab__who">
        <strong>
          {p.name}
          {isMe && <span className="df-collab__muted"> · {t('collab.you')}</span>}
        </strong>
        <span className="df-collab__muted">{where ? where : t('collab.noDoc')}</span>
      </div>
      {hosting && !isMe && p.role !== 'host' ? (
        <select
          className="df-collab__role"
          aria-label={t('collab.roleFor', { name: p.name })}
          value={p.role}
          onChange={(e) => setPeerRole(p.id, e.target.value as Role)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`collab.role.${r}`)}
            </option>
          ))}
        </select>
      ) : (
        <span className="df-collab__badge">{p.role === 'host' ? t('collab.hostShort') : t(`collab.role.${p.role}`)}</span>
      )}
      {!isMe && (
        <IconButton
          icon={following ? EyeOff : Eye}
          size="sm"
          label={following ? t('collab.unfollow') : t('collab.follow', { name: p.name })}
          active={following}
          onClick={() => setFollow(following ? null : p.id)}
        />
      )}
      {hosting && !isMe && p.role !== 'host' && (
        <IconButton
          icon={UserX}
          size="sm"
          label={t('collab.remove', { name: p.name })}
          onClick={() =>
            void ask(t('collab.removeTitle', { name: p.name }), t('collab.removeBody'), [
              { id: 'remove', label: t('collab.removeShort'), variant: 'danger' },
              { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
            ]).then((c) => c === 'remove' && kickPeer(p.id))
          }
        />
      )}
    </li>
  );
}

function Chat() {
  const { t } = useTranslation();
  const chat = useCollab((s) => s.chat);
  const me = useCollab((s) => s.me);
  const [text, setText] = useState('');
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    markChatRead();
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    sendChat(text);
    setText('');
  };
  return (
    <section className="df-collab__chat" aria-label={t('collab.chat')}>
      <h3>{t('collab.chat')}</h3>
      <ol ref={list} aria-live="polite">
        {chat.length === 0 && <li className="df-collab__muted">{t('collab.chatEmpty')}</li>}
        {chat.map((m) => (
          <li key={m.id} className={m.peer === me?.id ? 'is-mine' : ''}>
            <span className="df-collab__chat-name" style={{ color: m.color }}>
              {m.name}
            </span>
            <span className="df-collab__chat-time">{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="df-collab__chat-form">
        <input className="df-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('collab.chatPlaceholder')} aria-label={t('collab.chatPlaceholder')} maxLength={2000} />
        <IconButton icon={Send} size="sm" label={t('collab.send')} type="submit" disabled={!text.trim()} />
      </form>
    </section>
  );
}

export function CollabPanel() {
  const { t } = useTranslation();
  const s = useCollab();
  const hosting = s.status === 'hosting';
  if (s.status === 'off' || s.status === 'starting' || s.status === 'joining') {
    return (
      <div className="df-collab">
        <EmptyState icon={Users} title={t('collab.emptyTitle')}>
          <p>{t('collab.emptyBody')}</p>
          {s.status === 'off' ? (
            <div className="df-collab__actions">
              <Button size="sm" variant="primary" icon={Share2} onClick={() => useUi.setState({ collabDialog: 'host' })}>
                {t('collab.shareProject')}
              </Button>
              <Button size="sm" variant="secondary" icon={LogIn} onClick={() => useUi.setState({ collabDialog: 'join' })}>
                {t('collab.joinSession')}
              </Button>
            </div>
          ) : (
            <p className="df-collab__muted">
              <Spinner size={12} /> {s.status === 'starting' ? t('collab.starting') : t('collab.joining')}
            </p>
          )}
          {s.error && <p className="df-collab__error">{s.error}</p>}
        </EmptyState>
      </div>
    );
  }
  const others = s.peers;
  const copy = () =>
    s.invitation && void navigator.clipboard.writeText(s.invitation).then(() => toast({ kind: 'success', title: t('collab.inviteCopied') }));
  return (
    <div className="df-collab">
      <div className="df-panel-toolbar">
        <Users size={14} aria-hidden />
        <span className="df-collab__title">{hosting ? t('collab.hostingTitle') : t('collab.guestTitle', { project: s.project ?? '' })}</span>
        <span className="df-panel-toolbar__spacer" />
        <Button size="sm" variant="ghost" icon={LogOut} onClick={() => void endSession()}>
          {hosting ? t('collab.end') : t('collab.leave')}
        </Button>
      </div>
      <div className="df-collab__body">
        {hosting && s.invitation && (
          <section className="df-collab__invite">
            <label htmlFor="df-collab-invite">{t('collab.invitation')}</label>
            <div className="df-collab__invite-row">
              <input id="df-collab-invite" className="df-input" readOnly value={s.invitation} onFocus={(e) => e.target.select()} />
              <IconButton icon={Copy} size="sm" label={t('collab.copyInvite')} onClick={copy} />
            </div>
            <p className="df-field__hint">{s.lan ? t('collab.lanHint', { address: s.addresses[0] }) : t('collab.localHint', { port: s.addresses[0]?.split(':').pop() })}</p>
          </section>
        )}
        <section>
          <h3>{t('collab.participants', { count: others.length + 1 })}</h3>
          <ul className="df-collab__peers">
            {s.me && <PeerRow p={s.me} hosting={hosting} isMe />}
            {others.map((p) => (
              <PeerRow key={p.id} p={p} hosting={hosting} isMe={false} />
            ))}
          </ul>
          {hosting && others.length === 0 && <p className="df-collab__muted">{t('collab.waiting')}</p>}
        </section>
        <Chat />
      </div>
    </div>
  );
}
