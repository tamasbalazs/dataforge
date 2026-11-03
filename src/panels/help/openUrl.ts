import { host } from '../../core/host';

/** Open http(s) links in the system browser. */
export async function openExternalUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  await host().openUrl(url);
}
