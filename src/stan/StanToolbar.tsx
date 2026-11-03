/** Editor toolbar for .stan files: compiler status and model actions. */
import { AlertCircle, Braces, CheckCircle2, Hammer, ListPlus, PlayCircle, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Doc } from '../panels/editor/editorStore';
import { IconButton } from '../ui/Button';
import { chordLabel } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { useStan } from './language';
import { compileWithCmdstanr, copyDataTemplate, formatStan, togglePedantic } from './stanActions';

export function StanToolbar({ doc }: { doc: Doc }) {
  const { t } = useTranslation();
  // Model URIs are inmemory://dataforge/<doc id>/<name>.
  const st = useStan((s) => Object.entries(s.status).find(([k]) => k.includes(`/${doc.id}/`))?.[1]);
  const pedantic = useStan((s) => s.pedantic);
  const label = !st
    ? t('stan.checking')
    : st.unavailable
      ? t('stan.unavailable')
      : st.errors
        ? t('stan.errors', { count: st.errors })
        : st.warnings
          ? t('stan.warnings', { count: st.warnings })
          : t('stan.ok');
  const tone = st?.errors || st?.unavailable ? 'is-error' : st?.warnings ? 'is-warning' : 'is-ok';
  return (
    <div className="df-editor__toolbar">
      <span className={`df-stan-status ${tone}`} role="status" title={st?.unavailable ?? t('stan.statusHint')}>
        {!st || st.checking ? <Spinner size={12} /> : st.errors || st.unavailable ? <AlertCircle size={13} aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
        {label}
      </span>
      <IconButton icon={Wand2} size="sm" label={t('stan.format')} shortcut={chordLabel('Shift+Alt+F')} onClick={formatStan} />
      <IconButton icon={ListPlus} size="sm" label={t('stan.dataTemplate')} onClick={() => void copyDataTemplate()} />
      <IconButton icon={Braces} size="sm" label={t('stan.pedantic')} active={pedantic} onClick={togglePedantic} />
      <IconButton icon={Hammer} size="sm" label={t('stan.compile')} onClick={() => void compileWithCmdstanr()} />
      <IconButton icon={PlayCircle} size="sm" tone="accent" label={t('stan.sampleJob')} onClick={() => void import('../jobs/jobDialog').then((m) => m.openJobDialog({ stanFile: doc.path }))} />
    </div>
  );
}
