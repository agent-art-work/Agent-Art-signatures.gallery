/** Read-only, same-origin monitoring. Never assess, authorize, sign, or resubmit. */
export const REVEAL_MONITOR_SCRIPT = String.raw`(() => {
  const root = document.querySelector('[data-reveal-monitor]');
  if (!root || root.dataset.revealBound) return;
  root.dataset.revealBound = 'true';
  const { revealHandle: handle, revealToken: token, revealArtifact: artifact, revealInput: input, revealRenderer: renderer } = root.dataset;
  const badge = root.querySelector('[data-mint-state-label]');
  const feedback = root.querySelector('[data-reveal-feedback]');
  const artwork = root.querySelector('[data-reveal-artwork]');
  const provenance = root.querySelector('[data-reveal-provenance]');
  if (!badge || !feedback || !artwork || !provenance) return;
  const mintProcess = !!root.closest('[data-mint-process],[data-assessment-code],[data-mint-entry]');
  const mountedWarning = document.querySelector('[data-mint-observation-warning]');
  const mountedMessage = document.querySelector('[data-mint-observation-message]');
  const sharedNotice = mountedWarning && mountedMessage;
  const clearNotice = () => {
    if (!sharedNotice) return;
    mountedMessage.textContent = ''; mountedWarning.hidden = true;
    if (mountedWarning.dataset.noticeOwner === 'mint-confirmation') delete mountedWarning.dataset.noticeOwner;
  };
  if (!mintProcess) clearNotice();
  else if (sharedNotice && !mountedWarning.hidden) mountedWarning.dataset.noticeOwner = 'mint-confirmation';
  let stopped = false, timer, active, failures = 0, generation = 0;
  const say = (label, text, warning = false) => {
    badge.textContent = label;
    feedback.replaceChildren();
    if (warning && sharedNotice) {
      // The full mint page owns one notice mount. Do not repeat the same
      // warning in local reveal feedback, and fence off admission polling.
      mountedMessage.textContent = text; mountedWarning.hidden = false;
      mountedWarning.dataset.noticeOwner = 'mint-confirmation';
      feedback.className = ''; feedback.hidden = true;
      return;
    }
    clearNotice();
    feedback.hidden = !text;
    feedback.className = warning ? 'open-preview-notice open-preview-warning' : '';
    if (warning) {
      const title = document.createElement('strong');
      title.className = 'open-preview-notice-label'; title.textContent = 'Warning';
      feedback.append(title, document.createTextNode(' '));
    }
    feedback.append(document.createTextNode(text));
  };
  const unavailable = () => {
    if (mintProcess) {
      say('Confirmation unavailable', 'Confirmation status is temporarily unavailable. Checking again. No new mint will be submitted.', true);
    } else {
      // Browsing reads the relay's last verified facts. A failed refresh does
      // not change those facts or make its RPC diagnostics the viewer's task.
      clearNotice();
      feedback.className = ''; feedback.replaceChildren(); feedback.hidden = true;
    }
  };
  const disputed = new Error('disputed');
  const recheckDisputed = () => {
    // A contradictory successful result is not a refresh outage. Preserve the
    // reveal, but no longer present its previous inclusion as current evidence.
    artwork.hidden = false; provenance.hidden = false; root.dataset.mintState = 'rechecking';
    say('Rechecking mint', mintProcess ? 'The latest mint result does not match this signature. Checking again; do not submit another mint.' : '', mintProcess);
  };
  const digest = value => /^0x[0-9a-f]{64}$/i.test(value || '');
  if (!/^[a-z0-9_]{1,15}$/.test(handle || '') || !/^[0-9]{1,78}$/.test(token || '')
    || (input !== undefined ? !digest(input) || !digest(renderer) || artifact !== undefined : !digest(artifact))) { unavailable(); return; }
  const poll = async () => {
    if (stopped) return;
    const mine = ++generation;
    const controller = new AbortController(); active = controller;
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 8000); });
    const start = performance.now();
    try {
      const state = await Promise.race([deadline, (async () => {
      const response = await fetch('/api/signatures/' + handle + '/status', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('unavailable');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted || performance.now() - start >= 8000) throw new Error('timeout');
        if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); throw new Error('oversized'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
      })()]);
      if (stopped || mine !== generation) return;
      const included = state?.state === 'minted' || state?.state === 'confirming';
      if (state?.handle !== handle || state.tokenId !== token) {
        const otherHandle = typeof state?.handle === 'string' && /^[a-z0-9_]{1,15}$/.test(state.handle) && state.handle !== handle;
        const otherToken = typeof state?.tokenId === 'string' && /^[0-9]{1,78}$/.test(state.tokenId) && state.tokenId !== token;
        if (included && (otherHandle || otherToken)) throw disputed;
        throw new Error('binding');
      }
      if (included) {
        const commitmentConflict = input !== undefined
          ? (digest(state.inputDigest) && state.inputDigest !== input) || (digest(state.rendererIdentity) && state.rendererIdentity !== renderer) || digest(state.artifactDigest)
          : (digest(state.artifactDigest) && state.artifactDigest !== artifact) || digest(state.inputDigest);
        if (commitmentConflict) throw disputed;
        if (input !== undefined ? state.inputDigest !== input || state.rendererIdentity !== renderer || state.artifactDigest !== undefined
          : state.artifactDigest !== artifact || state.inputDigest !== undefined) throw new Error('commitment');
        if (state.state === 'minted') { stopped = true; location.reload(); return; }
        artwork.hidden = false; provenance.hidden = false; root.dataset.mintState = 'confirming';
        say('Confirming', 'Your signature is revealed and visible in the gallery. The mint succeeded and is still confirming.');
      } else if (state.state === 'pending' || state.state === 'unminted') {
        // A previously verified reveal is not undone visually. Keep the art
        // and provenance, but stop claiming that its mint is currently included.
        artwork.hidden = false; provenance.hidden = false; root.dataset.mintState = 'rechecking';
        say('Rechecking mint', mintProcess ? 'This is your previously revealed signature. Its mint is no longer verified in the current chain. Checking again; do not submit another mint.' : '', mintProcess);
      } else throw new Error('state');
      failures = 0;
    } catch (error) {
      if (stopped || mine !== generation) return;
      failures++;
      if (error === disputed) recheckDisputed();
      else unavailable();
    } finally {
      clearTimeout(timeout); controller.abort();
      if (active === controller) active = undefined;
      if (!stopped && mine === generation) timer = setTimeout(poll, Math.min(30000, 5000 * 2 ** Math.min(failures, 3)));
    }
  };
  window.addEventListener('pagehide', () => { stopped = true; generation++; clearTimeout(timer); active?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted && stopped) { stopped = false; void poll(); } });
  void poll();
})();
`;
