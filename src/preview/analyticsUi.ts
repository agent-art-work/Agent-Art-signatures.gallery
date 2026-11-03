import { createAnalytics } from './analytics.js';
import { galleryAnalytics } from './analyticsMarkup.js';
/** Quiet information/exclusion only; never a popup or permission request. */
export function bindAnalytics(document: Document, window: Window): void {
  if (!document.getElementById('measurement-privacy')) return;
  let config = galleryAnalytics('');
  try { config = JSON.parse(document.getElementById('analytics-config')?.textContent ?? ''); }
  catch { /* Malformed configuration stays disabled. */ }
  const render = (state: any) => {
    const status = document.getElementById('analytics-status');
    if (status) status.textContent = state.reloadRequired
      ? 'Save your work and reload this tab to end the old measurement document. A final in-flight measurement may complete.'
      : !state.storageAvailable ? 'Measurement is off here. Browser exclusion could not be read or saved.'
      : state.excluded ? 'This browser is excluded from audience measurement.'
      : state.started ? 'Qualified statistical measurement is active on this public page.'
      : 'Browser measurement is off. No new analytics cookie or visitor identifier is created by this site.';
    for (const control of document.querySelectorAll<HTMLButtonElement>('[data-analytics-action]')) {
      control.hidden = control.dataset.analyticsAction === 'include' ? !state.excluded : state.excluded;
    }
  };
  const controller = createAnalytics({ window, document, config, onChange: render });
  document.addEventListener('click', event => {
    const action = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-analytics-action]')?.dataset.analyticsAction;
    if (action === 'exclude') controller.exclude();
    if (action === 'include') controller.include();
  });
}
