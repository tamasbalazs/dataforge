/** Browser stand-in for background jobs: simulated Stan sampling output. */
import type { Host, JobInfo } from './host';

type Mock = Pick<Host, 'jobStart' | 'jobList' | 'jobPoll' | 'jobCancel' | 'jobRemove' | 'jobRead'>;

export function createMockJobs(): Mock {
  const jobs = new Map<string, { info: JobInfo; log: string; timer?: ReturnType<typeof setInterval> }>();
  let n = 0;
  const finish = (id: string, status: JobInfo['status'], code: number) => {
    const j = jobs.get(id)!;
    clearInterval(j.timer);
    j.info = { ...j.info, status, exitCode: code };
  };
  return {
    async jobStart(_w, spec) {
      const id = `20261102-120000-mock${++n}`;
      const info: JobInfo = { id, name: spec.name, kind: spec.kind, cwd: spec.cwd, dir: `/home/demo/.dataforge/jobs/${id}`, created: Date.now(), status: 'running', exitCode: null, logSize: 0, meta: spec.meta ?? null };
      const j: { info: JobInfo; log: string; timer?: ReturnType<typeof setInterval> } = { info, log: '' };
      jobs.set(id, j);
      const chains = Number((spec.meta as any)?.stan?.chains ?? 4);
      const total = 2000;
      let step = 0;
      const steps = 8;
      if (spec.kind === 'stan') j.log += `DataForge: compiling model\nRunning MCMC with ${chains} parallel chains...\n\n`;
      j.timer = setInterval(() => {
        step++;
        if (spec.kind === 'stan') {
          for (let c = 1; c <= chains; c++) {
            const it = Math.min(total, Math.round((step / steps) * total * (1 - c * 0.04)));
            j.log += `Chain ${c} Iteration: ${String(it).padStart(4)} / ${total} [${String(Math.round((it / total) * 100)).padStart(3)}%]  (${it > total / 2 ? 'Sampling' : 'Warmup'})\n`;
          }
          if (step >= steps) {
            for (let c = 1; c <= chains; c++) j.log += `Chain ${c} finished in ${(2 + c / 10).toFixed(1)} seconds.\n`;
            j.log += `\nAll ${chains} chains finished successfully.\nWarning: 3 of 4000 (0.0%) transitions ended with a divergence.\n`;
            finish(id, 'done', 0);
          }
        } else {
          j.log += `> # step ${step}\n[1] ${step * 7}\n`;
          if (step >= 4) finish(id, 'done', 0);
        }
        j.info = { ...j.info, logSize: j.log.length };
      }, 600);
      return info;
    },
    async jobList() {
      return [...jobs.values()].map((j) => j.info).sort((a, b) => b.created - a.created);
    },
    async jobPoll(_w, id, offset) {
      const j = jobs.get(id);
      if (!j) throw new Error(`no such job: ${id}`);
      return { info: { ...j.info, logSize: j.log.length }, data: j.log.slice(offset), nextOffset: j.log.length };
    },
    async jobCancel(_w, id) {
      const j = jobs.get(id);
      if (j && j.info.status === 'running') {
        j.log += '\nTerminated\n';
        finish(id, 'cancelled', 143);
      }
    },
    async jobRemove(_w, id) {
      const j = jobs.get(id);
      if (j?.info.status === 'running') throw new Error('the job is still running – cancel it first');
      jobs.delete(id);
    },
    async jobRead(_w, id) {
      return jobs.get(id)?.log ?? '';
    },
  };
}
