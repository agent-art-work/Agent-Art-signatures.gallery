import { createAnalytics, type AnalyticsConfig } from "./analytics.js";

/** Binds the consent notice and choices dialog rendered by the page layout. */
export function bindAnalytics(document: Document, window: Window): void {
  const analyticsDialog = document.getElementById('analytics-settings') as HTMLDialogElement | null;
  const analyticsNotice = document.getElementById('analytics-notice');
  const analyticsOpen = document.querySelector<HTMLButtonElement>('[data-analytics-action="open"]');
  if (analyticsDialog && analyticsNotice && analyticsOpen) {
    let analyticsConfig: AnalyticsConfig = { enabled: false, measurementId: null, production: false };
    try {
      analyticsConfig = JSON.parse(document.getElementById('analytics-config')?.textContent ?? '');
    } catch { /* Missing/malformed config leaves analytics off. */ }
    let analyticsReturnFocus: HTMLElement | undefined;
    const renderAnalytics = (state: any) => {
      let message = 'Analytics is off.';
      if (!state.storageAvailable) message = 'Analytics is off here. Your preference could not be saved; this browser may not remember it on another visit.';
      else if (state.excluded) message = 'This browser is excluded from analytics until you remove the exclusion. Clearing site storage also removes it.';
      else if (state.choice === 'reject') message = 'You have rejected analytics. Further measurement is disabled on this page.';
      else if (state.reloadRequired) message = 'Analytics stays off on this page. A saved allowance can take effect on your next eligible page visit.';
      else if (state.allowed) message = 'Analytics is allowed on this page. Reject analytics to withdraw your permission.';
      else if (!analyticsConfig.enabled || !analyticsConfig.measurementId) message = 'Analytics is not enabled for this site. No Google analytics is loaded.';
      else if (!state.eligible) message = 'Analytics is unavailable on this page or in this browser.';
      document.getElementById('analytics-status')!.textContent = message;
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-analytics-action="allow"]')) {
        button.disabled = !state.eligible || !state.storageAvailable || state.excluded;
      }
      document.querySelector<HTMLElement>('[data-analytics-action="include"]')!.hidden = !state.excluded;
      document.querySelector<HTMLElement>('[data-analytics-action="exclude"]')!.hidden = state.excluded;
      analyticsNotice.hidden = !state.eligible || !state.storageAvailable || state.excluded || ['allow', 'reject'].includes(state.choice) || state.reloadRequired || analyticsDialog.open;
    };
    const analyticsController = createAnalytics({ window, document, config: analyticsConfig, onChange: renderAnalytics });
    renderAnalytics(analyticsController.status());
    analyticsOpen.hidden = false;
    document.addEventListener('click', event => {
      const control = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-analytics-action]');
      if (!control || control.disabled) return;
      const action = control.dataset.analyticsAction ?? '';
      if (action === 'open') {
        analyticsReturnFocus = control;
        analyticsController.refresh();
        analyticsDialog.showModal();
        analyticsNotice.hidden = true;
        analyticsDialog.querySelector('h2')?.focus({ preventScroll: true });
      } else if (action === 'close') {
        analyticsDialog.close();
      } else if (['allow', 'reject', 'exclude', 'include'].includes(action)) {
        renderAnalytics(analyticsController[action]());
        // A dismissed notice must not strand keyboard focus in hidden controls.
        if (analyticsNotice.contains(control)) analyticsOpen.focus({ preventScroll: true });
      }
    });
    analyticsDialog.addEventListener('close', () => {
      renderAnalytics(analyticsController.status());
      const target = analyticsReturnFocus?.isConnected && analyticsReturnFocus.getClientRects().length
        ? analyticsReturnFocus : analyticsOpen;
      target.focus({ preventScroll: true });
    });
  }
}
