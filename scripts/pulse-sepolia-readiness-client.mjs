/** Read-only progressive recovery. No wallet API, form submission, consent,
 * authorization, transaction or navigation is initiated by this monitor. */
import { sitePhasePresentation } from '../src/openMint/sitePhase.ts';
export function sepoliaReadinessClient(phasePresentation) {
  let timer, stopped = false, revision, lastReady, lastSale, saleRevision, generation = 0, pollFailures = 0, pollFailureSince, readyUntil = 0;
  const $ = selector => document.querySelector(selector);
  const mintProcess = () => !!($('[data-mint-process]') || $('[data-mint-entry]') || $('[data-assessment-code]'));
  const unavailableMint = 'Mint availability cannot be checked right now. Please try again shortly.';
  function notice(text) {
    const warning = $('[data-mint-observation-warning]'), message = $('[data-mint-observation-message]');
    // Confirmation belongs to the mint-status client, not to general sale
    // readiness. A new-mint capability poll must not erase an in-flight result.
    const completedResult = !$('[data-mint-entry]') && !$('[data-mint-form]') && $('.signature-page[data-mint-state="minted"]');
    if (mintProcess() && (warning?.dataset?.noticeOwner === 'mint-confirmation' || $('[data-mint-result]')?.hidden === false || $('[data-reveal-monitor]'))) return;
    if (completedResult) text = undefined;
    if (warning && message) {
      message.textContent = text || ''; warning.hidden = !text;
      // The same admission failure may arrive first through a user action.
      // Keep one shared notice, without erasing unrelated wallet/transaction
      // feedback or modifying readiness/consent/confirmation state.
      if (text) for (const local of document.querySelectorAll('[data-inline-warning-message]')) {
        if (local === warning || local.dataset.noticeOwner === 'mint-confirmation'
          || local.dataset.inlineWarningMessage !== text) continue;
        local.textContent = '';
        local.classList.remove('open-preview-notice', 'open-preview-warning');
        delete local.dataset.inlineWarningMessage;
      }
    }
  }
  function readiness(ready, saleStatus = lastSale) {
    const nextSaleRevision = JSON.stringify(saleStatus);
    if (ready === lastReady && nextSaleRevision === saleRevision) return;
    lastReady = ready;
    lastSale = saleStatus; saleRevision = nextSaleRevision;
    window.dispatchEvent(new CustomEvent('sg:readiness-changed', { detail: { mintReady: ready, saleStatus } }));
  }
  function salePresentation(sale) {
    if (!sale || !['prelaunch', 'free', 'paid', 'unknown'].includes(sale.phase) || typeof sale.paused !== 'boolean') return undefined;
    const presentation = phasePresentation(sale);
    const label = $('[data-home-mint-label]'), status = $('[data-home-mint-status]');
    if (label) label.textContent = presentation.ctaLabel;
    $('[data-home-mint-cta]')?.setAttribute('href', presentation.ctaHref);
    const explore = $('[data-home-explore]'); if (explore) explore.hidden = presentation.prelaunch;
    $('[data-collection-mint-cta]')?.setAttribute('href', presentation.ctaHref);
    const collectionLabel = $('[data-collection-mint-label]'); if (collectionLabel) collectionLabel.textContent = presentation.ctaLabel;
    const bridge = $('[data-preview-mint-link]');
    if (bridge) bridge.hidden = presentation.prelaunch || presentation.paused || presentation.phase === 'unknown';
    const previewStatus = $('[data-preview-sale-status]');
    if (previewStatus) { previewStatus.hidden = !bridge?.hidden; previewStatus.textContent = bridge?.hidden ? presentation.status : ''; }
    if (status) {
      status.textContent = presentation.status;
      status.hidden = false;
    }
    return sale;
  }
  async function update() {
    if (stopped) return;
    if (document.hidden) { timer = setTimeout(update, 5000); return; }
    const epoch = generation;
    try {
      const response = await fetch('/api/test/capabilities', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error();
      const state = await response.json();
      if (state.chainId !== 11155111 || typeof state.mintReady !== 'boolean' || typeof state.revision !== 'string' || state.revision.length > 32768) throw Object.assign(Error(), { invalidCapability: true });
      if (stopped || epoch !== generation) return;
      pollFailures = 0; pollFailureSince = undefined;
      const now = Date.now();
      // Keep a recently verified readiness flag through a brief failed HTTP
      // poll, never beyond the backend's 90-second sale-evidence window.
      // Explicit pause, conflict, wrong chain or false readiness revoke it now.
      const ready = state.mintReady && state.saleStatus?.phase !== 'prelaunch' && state.saleStatus?.paused !== true
        && !state.safetyHalted && !['paused', 'halted'].includes(state.mintState);
      readyUntil = ready ? Math.min(now + 15000,
        typeof state.lastSaleCheckedAt === 'number' && Number.isFinite(state.lastSaleCheckedAt) ? state.lastSaleCheckedAt + 90000 : now + 15000) : 0;
      // Viewing is served by the relay: RPC refresh and ownership diagnostics
      // are operator concerns, not viewer warnings. Only an actual mint flow
      // exposes actionable admission failures; a reveal monitor alone is not one.
      const mintPage = mintProcess();
      const collectionPage = !!$('[data-collection-page]');
      notice(mintPage ? state.safetyHalted ? state.mintNotice || 'Previously verified mints need to be checked before minting can continue.'
        : state.mintState === 'unavailable' ? unavailableMint : undefined : undefined);
      readiness(ready, salePresentation(state.saleStatus));
      const viewRevision = collectionPage ? state.revision + ':' + state.collectionRevision : state.revision;
      if (revision !== viewRevision) {
        try {
          // Replace only gallery results; keep the hero, controls and consent.
          const root = $('.gallery-shell') || $('[data-mbti-gallery]') || $('[data-collection-page]');
          if (root) {
            const page = await fetch(location.pathname, { signal: AbortSignal.timeout(5000) });
            if (!page.ok) throw Error();
            const parsed = new DOMParser().parseFromString(await page.text(), 'text/html');
            if (stopped || epoch !== generation) return;
            const next = parsed.querySelector('.gallery-shell') || parsed.querySelector('[data-mbti-gallery]') || parsed.querySelector('[data-collection-page]');
            if (next) {
              const old = root.querySelector('.public-gallery-grid') || root.querySelector('.open-gallery-empty') || root.querySelector('.collection-empty');
              const fresh = next.querySelector('.public-gallery-grid') || next.querySelector('.open-gallery-empty') || next.querySelector('.collection-empty');
              if (fresh && old?.outerHTML !== fresh.outerHTML) {
                if (old) old.replaceWith(fresh); else root.append(fresh);
              } else if (!fresh) old?.remove();
              for (const image of root.querySelectorAll('.gallery-card img')) {
                if (image.complete && !image.naturalWidth) {
                  const url = new URL(image.src, location.href);
                  if (url.origin === location.origin && /^\/test-art\/[a-z0-9_]{1,15}\.svg$/.test(url.pathname)) {
                    url.searchParams.set('cache', String(state.cache?.revision ?? 0)); image.src = url.href;
                  }
                }
              }
            }
          }
          revision = viewRevision;
        } catch {
          // HTML refresh failure is not failed capability evidence. Preserve
          // known cards/readiness and retry this revision on the next poll.
        }
      }
    } catch (error) {
      // Preserve artwork and user input on transport failure. The backend is
      // the authority for mint readiness, not an optimistic browser flag.
      if (!stopped && epoch === generation) {
        pollFailures++; pollFailureSince ??= Date.now();
        if (!mintProcess()) notice(undefined);
        else notice(error.invalidCapability || pollFailures >= 3 && Date.now() - pollFailureSince >= 15000 ? unavailableMint : undefined);
        if (error.invalidCapability) readyUntil = 0;
        readiness(lastReady === true && Date.now() < readyUntil);
      }
    } finally { if (!stopped && epoch === generation) timer = setTimeout(update, 5000); }
  }
  window.addEventListener('pagehide', () => { stopped = true; generation++; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; generation++; void update(); } });
  // Also remove notices from an older server-rendered viewer document before
  // the first poll resolves, including while the backend is unreachable.
  if (!mintProcess()) notice(undefined);
  void update();
}
export const SEPOLIA_READINESS_CLIENT = `(${sepoliaReadinessClient.toString()})(${sitePhasePresentation.toString()});`;
