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
  let stopped = false, timer, active, failures = 0, generation = 0;
  const say = (label, text, warning = false) => {
    badge.textContent = label;
    feedback.className = warning ? 'open-preview-notice open-preview-warning' : '';
    feedback.replaceChildren();
    if (warning) {
      const title = document.createElement('strong');
      title.className = 'open-preview-notice-label'; title.textContent = 'Warning';
      feedback.append(title, document.createTextNode(' '));
    }
    feedback.append(document.createTextNode(text));
  };
  const unavailable = () => say('Confirmation unavailable', 'Confirmation status is temporarily unavailable. Checking again. No new mint will be submitted.', true);
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
      if (state?.handle !== handle || state.tokenId !== token) throw new Error('binding');
      if (state.state === 'minted' || state.state === 'confirming') {
        if (input !== undefined ? state.inputDigest !== input || state.rendererIdentity !== renderer || state.artifactDigest !== undefined
          : state.artifactDigest !== artifact || state.inputDigest !== undefined) throw new Error('commitment');
        if (state.state === 'minted') { stopped = true; location.reload(); return; }
        artwork.hidden = false; provenance.hidden = false; root.dataset.mintState = 'confirming';
        say('Confirming', 'Your signature is revealed. The mint is included in a block and still confirming. It will appear in the gallery once confirmed.');
      } else if (state.state === 'pending' || state.state === 'unminted') {
        artwork.hidden = true; provenance.hidden = true; root.dataset.mintState = 'rechecking';
        say('Rechecking mint', 'The mint is no longer verified in the current chain. Your saved signature is unchanged. Checking again; do not submit another mint.', true);
      } else throw new Error('state');
      failures = 0;
    } catch {
      if (stopped || mine !== generation) return;
      failures++; unavailable();
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
