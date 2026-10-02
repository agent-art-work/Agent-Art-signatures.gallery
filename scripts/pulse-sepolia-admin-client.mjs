import { renderInlineFeedback } from '../src/openMint/inlineFeedback.ts';

/** Browser factory is serialized below; all dependencies remain explicit. */
export function sepoliaAdminClient(renderFeedback = renderInlineFeedback) {
  const $ = selector => document.querySelector(selector);
  const page = $('[data-admin-page]');
  if (!page) return;
  const collection = page.dataset.adminCollection?.toLowerCase();
  const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
  const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
  const identifier = value => typeof value === 'string' && /^[a-z0-9_-]{1,160}$/i.test(value);
  const decimal = value => /^(0|[1-9][0-9]*)$/.test(String(value)) && BigInt(value) < 2n ** 256n;
  const chainId = '0xaa36a7';
  const storageKey = 'sg-sepolia-admin-pending:' + collection;
  let csrf, wallet, provider, watchedProvider, detachWallet, status, review, pending, statusRequest;
  let sessionReady = false, connecting = false, restoring = false, busy = false, draftLoaded = false;
  let epoch = 0, draftEpoch = 0, statusEpoch = 0, pollEpoch = 0, pollTimer, pollCount = 0, pollRequest, stopped = false;
  const providers = [];
  const feedback = (kind, text, warning = false) => renderFeedback($('[data-admin-' + kind + '-feedback]'), text, warning);
  const bestProvider = () => providers.find(value => value.provider.isRabby || value.info?.rdns === 'io.rabby')?.provider
    || (window.ethereum?.isRabby ? window.ethereum : undefined) || window.ethereum || providers[0]?.provider;
  const fingerprint = value => {
    const p = value?.policy;
    return p ? JSON.stringify([value.admin?.toLowerCase(), p.root?.toLowerCase(), ...['slotCount', 'quota', 'revision', 'freeMinted', 'freeDeadline', 'phase'].map(key => String(p[key]))]) : undefined;
  };
  const draft = () => ({ wallets: $('[data-admin-wallets]')?.value ?? '', quota: $('[data-admin-quota]')?.value ?? '' });
  const draftMatches = value => !!value && value.wallets === draft().wallets && value.quota === draft().quota;
  const adminReady = () => !!(wallet && provider && status && status.admin.toLowerCase() === wallet.toLowerCase());
  const ready = () => adminReady() && !busy && !connecting && !restoring && !pending;
  const canPause = () => (status?.canPause ?? status?.policy.canPause) !== false;
  const validReview = () => review && review.epoch === epoch && draftMatches(review.draft) && review.policy === fingerprint(status);
  function stopPolling() { pollEpoch++; clearTimeout(pollTimer); pollTimer = undefined; }
  function render() {
    const connect = $('[data-admin-connect]'), label = $('[data-admin-connect] > span');
    if (connect) connect.disabled = !sessionReady || busy || connecting || restoring;
    if (label) label.textContent = connecting ? 'Connecting…' : restoring ? 'Restoring wallet…' : wallet ? 'Reconnect admin wallet' : 'Connect admin wallet';
    const walletLabel = $('[data-admin-wallet-label]');
    if (walletLabel) walletLabel.textContent = wallet || 'Connect the admin wallet to manage this collection.';
    for (const name of ['wallets', 'quota']) if ($('[data-admin-' + name + ']')) $('[data-admin-' + name + ']').disabled = !ready() || status.policy.phase !== 0 || !!status.configurationError;
    for (const name of ['logout', 'refresh']) if ($('[data-admin-' + name + ']')) $('[data-admin-' + name + ']').disabled = !wallet || busy || connecting || restoring || name === 'refresh' && statusRequest?.epoch === epoch;
    const refreshLabel = $('[data-admin-refresh] > span'); if (refreshLabel) refreshLabel.textContent = statusRequest?.epoch === epoch ? 'Checking policy…' : 'Refresh policy';
    const reviewed = validReview();
    for (const [name, allowed] of [['review', ready() && status.policy.phase === 0 && !status.configurationError], ['pause', ready() && !status.policy.paused && canPause()],
      ['configure', ready() && status.policy.paused && status.policy.phase === 0 && !status.configurationError && reviewed && (!review.endsFreeMint || $('[data-admin-end-ack]')?.checked)],
      ['unpause', ready() && status.policy.paused && canPause()], ['reconcile', !!wallet && !!pending && !busy && !connecting && !restoring]]) {
      const node = $('[data-admin-' + name + ']'); if (node) node.disabled = !allowed;
    }
    const section = $('[data-admin-pending]'); if (section) section.hidden = !pending;
    const summary = $('[data-admin-pending-summary]'); if (summary) summary.textContent = pending
      ? (pending.action ? pending.action + ' · ' : '') + (pending.transactionHash ? 'Checking the submitted transaction. No additional transaction will be sent.' : 'The previous request has no recorded hash. Check wallet activity before continuing.') : '';
    const pendingHash = $('[data-admin-pending-hash]'); if (pendingHash) pendingHash.textContent = pending?.transactionHash || '';
    if (pending?.transactionHash && $('[data-admin-reconcile-hash]') && !$('[data-admin-reconcile-hash]').value) $('[data-admin-reconcile-hash]').value = pending.transactionHash;
  }
  function invalidateReview(message = '') {
    review = undefined;
    if ($('[data-admin-review-summary]')) $('[data-admin-review-summary]').hidden = true;
    if ($('[data-admin-end-ack]')) $('[data-admin-end-ack]').checked = false;
    feedback('review', message); render();
  }
  function savePending(value) {
    pending = value;
    try {
      if (!value) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify({ intentId: value.intentId, ...(value.transactionHash ? { transactionHash: value.transactionHash } : {}) }));
      return true;
    } catch { return false; }
  }
  function restorePending() {
    try {
      const raw = sessionStorage.getItem(storageKey); if (!raw) return;
      const value = JSON.parse(raw);
      if (!identifier(value.intentId) || value.transactionHash !== undefined && !hash(value.transactionHash)
        || Object.keys(value).some(key => !['intentId', 'transactionHash'].includes(key))) throw Error();
      pending = value;
    } catch { feedback('pending', 'Saved admin transaction details could not be read. Refresh the policy before continuing.', true); }
  }
  async function api(path, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), 60000) : undefined;
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(controller ? { signal: controller.signal } : {}) });
      const value = await response.json();
      if (!response.ok) {
        if (value.code === 'CONNECT_WALLET') {
          epoch++; statusEpoch++; stopPolling(); wallet = undefined; provider = undefined; status = undefined; detachWallet?.();
          invalidateReview(); feedback('wallet', 'Admin sign-in expired. Connect the admin wallet again.', true); render();
        }
        throw Object.assign(Error(value.error || 'The admin request could not be completed.'), { code: value.code, status: response.status });
      }
      return value;
    } catch (error) { if (controller?.signal.aborted) throw Error('The admin request timed out. Refresh the current policy and check pending wallet activity before continuing.'); throw error; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  function watch(active) {
    detachWallet?.(); watchedProvider = active;
    const changed = () => {
      if (watchedProvider !== active) return;
      epoch++; statusEpoch++; stopPolling();
      wallet = undefined; provider = undefined; status = undefined; draftLoaded = false;
      invalidateReview(); feedback('wallet', 'Wallet or network changed. Connect the admin wallet on Sepolia again.', true); render();
    };
    for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) active.on?.(name, changed);
    detachWallet = () => {
      for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) active.removeListener?.(name, changed);
      if (watchedProvider === active) watchedProvider = undefined;
    };
  }
  async function assertWallet(active, expected, generation) {
    if (stopped || epoch !== generation) throw Error('Wallet or network changed. Connect again.');
    const [accounts, chain] = await Promise.all([active.request({ method: 'eth_accounts' }), active.request({ method: 'eth_chainId' })]);
    if (epoch !== generation || !address(accounts?.[0]) || accounts[0].toLowerCase() !== expected.toLowerCase() || chain?.toLowerCase() !== chainId)
      throw Error('Wallet or network changed. Connect the admin wallet on Sepolia again.');
  }
  async function restoreWallet() {
    if (!wallet || provider || restoring || connecting || busy || stopped) return;
    const active = bestProvider(); if (!active) return;
    const expected = wallet, generation = epoch;
    restoring = true; watch(active); render();
    try {
      await assertWallet(active, expected, generation);
      provider = active; feedback('wallet', 'Admin wallet restored.');
    } catch (error) { if (generation === epoch) feedback('wallet', error.message, true); }
    finally { restoring = false; render(); if (wallet && !provider && bestProvider() !== active) void restoreWallet(); }
  }
  function validateStatus(value) {
    const p = value.policy;
    if (value.collection?.toLowerCase() !== collection || value.chainId !== 11155111 || !address(value.admin)
      || value.admin.toLowerCase() !== wallet?.toLowerCase() || !p || ![0, 1].includes(p.phase) || typeof p.paused !== 'boolean' || !hash(p.root)
      || !['slotCount', 'quota', 'revision', 'freeMinted', 'freeDeadline'].every(key => decimal(p[key]))
      || !Array.isArray(value.wallets) || !value.wallets.every(address)
      || value.pending && (!identifier(value.pending.intentId) || !['pause', 'configure', 'unpause'].includes(value.pending.action)
        || value.pending.transactionHash !== undefined && !hash(value.pending.transactionHash)
        || value.pending.hashValidated !== undefined && typeof value.pending.hashValidated !== 'boolean')) throw Error('Admin policy binding could not be verified.');
  }
  function refreshPolicy() {
    if (!wallet || stopped) return Promise.resolve();
    if (statusRequest?.epoch === epoch) return statusRequest.promise;
    const request = { epoch, number: ++statusEpoch };
    statusRequest = request; renderFeedback($('[data-admin-feedback]'), 'Checking current policy…'); render();
    request.promise = readPolicy(request).finally(() => { if (statusRequest === request) statusRequest = undefined; render(); });
    return request.promise;
  }
  async function readPolicy({ epoch: generation, number: request }) {
    try {
      const value = await api('/api/test/admin/status');
      if (generation !== epoch || request !== statusEpoch || stopped) return;
      validateStatus(value);
      if (status && fingerprint(status) !== fingerprint(value)) invalidateReview('Policy changed. Review the draft again before applying it.');
      status = value;
      if (!draftLoaded) { $('[data-admin-wallets]').value = value.wallets.join('\n'); $('[data-admin-quota]').value = String(value.policy.quota); draftLoaded = true; }
      for (const [name, text] of [['state', value.policy.paused ? 'Paused' : value.policy.phase === 0 ? 'Live Free' : 'Paid'],
        ['used', value.policy.freeMinted + ' / ' + value.policy.quota], ['slots', value.policy.slotCount], ['revision', value.policy.revision], ['root', value.policy.root]]) {
        const node = $('[data-admin-' + name + ']'); if (node) node.textContent = String(text);
      }
      const deadline = $('[data-admin-deadline]'), seconds = Number(value.policy.freeDeadline);
      if (deadline) deadline.textContent = seconds === 0 ? 'Not started' : Number.isSafeInteger(seconds) && seconds <= 8640000000000
        ? new Date(seconds * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : String(value.policy.freeDeadline) + ' Unix seconds';
      const resolved = pending && (value.lastIntent?.intentId === pending.intentId ? value.lastIntent
        : Array.isArray(value.resolvedIntents) ? value.resolvedIntents.find(row => row?.intentId === pending.intentId) : undefined);
      if (value.pending) {
        if (pending?.hashValidated && pending.intentId === value.pending.intentId && pending.transactionHash && value.pending.transactionHash
          && pending.transactionHash.toLowerCase() !== value.pending.transactionHash.toLowerCase()) throw Error('Pending transaction hash conflicts with the server record.');
        savePending({ ...value.pending, ...(value.pending.transactionHash ? {} : pending?.intentId === value.pending.intentId && pending.transactionHash ? { transactionHash: pending.transactionHash } : {}) });
      } else if (resolved && ['confirmed', 'reverted', 'abandoned', 'superseded'].includes(resolved.state)
        && ['pause', 'configure', 'unpause'].includes(resolved.action)) {
        savePending(undefined); stopPolling(); if (resolved.action === 'configure') invalidateReview();
        feedback('action', 'Previous admin request is ' + resolved.state + '. Current policy refreshed.', resolved.state === 'reverted');
      }
      renderFeedback($('[data-admin-feedback]'), value.configurationError || '', !!value.configurationError); render();
      if (pending?.transactionHash) void startPolling();
    } catch (error) {
      if (generation === epoch && request === statusEpoch) {
        status = undefined; invalidateReview(); feedback('policy', error.message, true); render();
        const note = $('[data-admin-feedback]'); renderFeedback(note, error.status === 403 ? 'This wallet is not the collection admin.' : error.message, true);
      }
    }
  }
  async function connect() {
    if (!sessionReady || connecting || restoring || busy || stopped) return;
    connecting = true; epoch++; statusEpoch++; stopPolling();
    wallet = undefined; provider = undefined; status = undefined; detachWallet?.(); invalidateReview(); render();
    try {
      const active = bestProvider(); if (!active) throw Error('Open this page with an Ethereum wallet to connect the collection admin.');
      if ((await active.request({ method: 'eth_chainId' }))?.toLowerCase() !== chainId)
        await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      const accounts = await active.request({ method: 'eth_requestAccounts' });
      if (!address(accounts?.[0])) throw Error('No wallet account was selected.');
      watch(active); const generation = epoch, expected = accounts[0];
      await assertWallet(active, expected, generation);
      feedback('wallet', 'Checking the admin account…');
      const challenge = await api('/api/test/admin/challenge', { address: expected });
      await assertWallet(active, expected, generation);
      if (!identifier(challenge.challengeId) || typeof challenge.message !== 'string' || !challenge.message) throw Error('Wallet sign-in challenge could not be verified.');
      feedback('wallet', 'Confirm the sign-in message in your wallet. This does not send a transaction.');
      const message = '0x' + [...new TextEncoder().encode(challenge.message)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const signature = await active.request({ method: 'personal_sign', params: [message, expected] });
      await assertWallet(active, expected, generation);
      const verified = await api('/api/test/verify', { challengeId: challenge.challengeId, signature });
      await assertWallet(active, expected, generation);
      if (verified.wallet?.toLowerCase() !== expected.toLowerCase()) throw Error('Wallet sign-in did not match the selected account.');
      wallet = verified.wallet; provider = active; feedback('wallet', 'Admin wallet connected.');
      await refreshPolicy();
    } catch (error) {
      wallet = undefined; provider = undefined; status = undefined;
      feedback('wallet', error.code === 4001 ? 'Wallet sign-in was cancelled.' : error.message, error.code !== 4001);
    } finally { connecting = false; render(); }
  }
  async function reviewChanges() {
    if (!ready() || status.policy.phase !== 0 || status.configurationError) return;
    const currentDraft = draft(), generation = epoch, edit = draftEpoch, policy = fingerprint(status);
    invalidateReview(); busy = true; render();
    try {
      if (!decimal(currentDraft.quota)) throw Error('Enter the total free quota as a whole number.');
      const rows = currentDraft.wallets.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!rows.every(address)) throw Error('Enter one complete Ethereum address per row.');
      const result = await api('/api/test/admin/review', currentDraft);
      if (generation !== epoch || edit !== draftEpoch || !draftMatches(currentDraft) || policy !== fingerprint(status)) return;
      if (!identifier(result.reviewId) || !hash(result.root) || !['slotCount', 'quota', 'previousQuota', 'previousSlotCount', 'revision', 'addedSlots', 'reassignedSlots'].every(key => decimal(result[key]))
        || String(result.quota) !== currentDraft.quota || BigInt(result.slotCount) !== BigInt(rows.length) || typeof result.endsFreeMint !== 'boolean'
        || result.endsFreeMint !== (BigInt(result.quota) === BigInt(status.policy.freeMinted))) throw Error('The reviewed change could not be verified.');
      review = { ...result, draft: currentDraft, epoch: generation, policy };
      for (const [name, text] of [['quota', result.previousQuota + ' → ' + result.quota], ['slots', result.previousSlotCount + ' → ' + result.slotCount],
        ['changes', result.addedSlots + ' added · ' + result.reassignedSlots + ' reassigned'], ['root', result.root]]) $('[data-admin-review-' + name + ']').textContent = text;
      $('[data-admin-review-summary]').hidden = false;
      $('[data-admin-end-warning]').hidden = !result.endsFreeMint; $('[data-admin-end-ack-label]').hidden = !result.endsFreeMint;
      feedback('review', 'Review ready. Pause minting before applying the change.');
    } catch (error) { if (generation === epoch && edit === draftEpoch) feedback('review', error.message, true); }
    finally { busy = false; render(); }
  }
  function validatedTransaction(plan, action, expected, reviewed) {
    const tx = plan.transaction;
    const encodeWord = value => BigInt(value).toString(16).padStart(64, '0');
    const data = action === 'configure' ? '0x6468c3a7' + reviewed.root.slice(2).toLowerCase() + encodeWord(reviewed.slotCount) + encodeWord(reviewed.quota)
      : action === 'pause' ? '0xda8fbf2a' : '0xae200322';
    if (!identifier(plan.intentId) || plan.action !== action || !tx || Object.keys(tx).some(key => !['from', 'to', 'chainId', 'data', 'value', 'gas', 'nonce'].includes(key))
      || !address(tx.from) || tx.from.toLowerCase() !== expected.toLowerCase() || !address(tx.to) || tx.to.toLowerCase() !== collection
      || tx.chainId !== chainId || tx.value !== '0x0' || tx.data?.toLowerCase() !== data
      || typeof tx.gas !== 'string' || !/^0x[0-9a-f]+$/i.test(tx.gas) || BigInt(tx.gas) <= 0n || BigInt(tx.gas) > 5000000n
      || tx.nonce !== undefined && (typeof tx.nonce !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(tx.nonce) || BigInt(tx.nonce) >= 2n ** 64n))
      throw Error('Transaction binding changed. No transaction was sent. Refresh the policy before continuing.');
    return { from: tx.from, to: tx.to, chainId, data: tx.data, value: '0x0', gas: tx.gas, ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }) };
  }
  async function act(action) {
    if (!ready() || !['pause', 'configure', 'unpause'].includes(action)) return;
    if (action !== 'configure' && !canPause()) return;
    if (action === 'pause' && status.policy.paused || action === 'unpause' && !status.policy.paused) return;
    const reviewed = validReview();
    if (action === 'configure' && (!status.policy.paused || status.policy.phase !== 0 || status.configurationError || !reviewed || review.endsFreeMint && !$('[data-admin-end-ack]')?.checked)) return;
    const active = provider, expected = wallet, generation = epoch, currentReview = review, edit = draftEpoch;
    let plan, sent = false;
    busy = true; render(); feedback('action', 'Checking the admin wallet and current policy…');
    try {
      await assertWallet(active, expected, generation);
      plan = await api('/api/test/admin/action', { action, ...(action === 'configure' ? { reviewId: currentReview.reviewId } : {}) });
      if (identifier(plan.intentId)) savePending({ intentId: plan.intentId, action });
      if (generation !== epoch || action === 'configure' && (edit !== draftEpoch || !validReview())) throw Error('Wallet or reviewed draft changed. No transaction was sent.');
      const tx = validatedTransaction(plan, action, expected, currentReview);
      if (!savePending({ intentId: plan.intentId, action })) throw Error('Transaction recovery details could not be saved. No transaction was sent; check the pending request before continuing.');
      await assertWallet(active, expected, generation);
      if (action === 'configure' && (edit !== draftEpoch || !validReview() || currentReview.endsFreeMint && !$('[data-admin-end-ack]')?.checked)) throw Error('The reviewed change is no longer confirmed. No transaction was sent.');
      feedback('action', 'Confirm ' + (action === 'configure' ? 'the allowlist and quota change' : action === 'pause' ? 'pausing minting' : 'resuming minting') + ' in your Sepolia wallet.');
      sent = true;
      const transactionHash = await active.request({ method: 'eth_sendTransaction', params: [tx] });
      if (!hash(transactionHash)) throw Error('The wallet returned no valid transaction hash. Check wallet activity and reconcile the pending request.');
      const saved = savePending({ intentId: plan.intentId, action, transactionHash });
      if (!saved) feedback('pending', 'The transaction hash could not be saved in this browser. Keep this page open and copy the hash from wallet activity.', true);
      if (generation !== epoch) { render(); return; }
      if (action === 'configure') invalidateReview();
      feedback('action', 'Transaction submitted. Waiting for confirmation.');
      await startPolling();
    } catch (error) {
      if (plan && identifier(plan.intentId) && (!sent || error.code === 4001 && !pending?.transactionHash)) {
        try {
          await api('/api/test/admin/cancel', { intentId: plan.intentId });
          savePending(undefined); stopPolling(); if (action === 'configure') invalidateReview();
          feedback('action', sent ? 'Wallet transaction was cancelled. Refreshing the current policy.' : error.message + ' The prepared request was closed.', !sent);
          if (generation === epoch) await refreshPolicy();
        } catch { feedback('action', (sent ? 'Wallet transaction was cancelled' : error.message) + ', but the prepared request could not be closed. Refresh the policy before continuing.', true); }
      } else feedback('action', sent ? 'Submission could not be confirmed. Check wallet activity and reconcile the pending request.' : error.message, true);
    } finally { busy = false; render(); }
  }
  async function reportPending(generation, ticket) {
    const current = pending;
    if (!wallet || !current?.transactionHash || generation !== epoch || ticket !== pollEpoch || stopped) return;
    try {
      const result = await api('/api/test/admin/report', { intentId: current.intentId, transactionHash: current.transactionHash });
      if (generation !== epoch || ticket !== pollEpoch || pending?.intentId !== current.intentId || stopped) return;
      if (!['pending', 'confirmed', 'reverted'].includes(result.state) || result.transactionHash?.toLowerCase() !== current.transactionHash.toLowerCase()
        || result.hashValidated !== undefined && typeof result.hashValidated !== 'boolean') throw Error('Transaction confirmation could not be verified.');
      if (result.state !== 'pending') {
        savePending(undefined); clearTimeout(pollTimer); pollTimer = undefined; pollEpoch++;
        if (current.action === 'configure') invalidateReview();
        feedback('action', result.state === 'confirmed' ? 'Admin transaction confirmed. Current policy refreshed.' : 'Admin transaction reverted. Check the current policy before trying again.', result.state === 'reverted');
        feedback('pending', ''); await refreshPolicy(); render(); return;
      }
      if (result.hashValidated === true) pending.hashValidated = true;
      feedback('pending', 'Transaction is still pending.');
    } catch (error) { if (generation === epoch && ticket === pollEpoch) feedback('pending', error.message + ' Check the transaction again when ready.', true); }
    if (generation === epoch && ticket === pollEpoch && pending?.transactionHash && !stopped) {
      if (++pollCount < 12) pollTimer = setTimeout(() => { pollTimer = undefined; void performReport(generation, ticket); }, 5000);
      else feedback('pending', 'Confirmation is still unresolved. Use Check transaction to continue checking this hash.', true);
    }
  }
  function performReport(generation, ticket) {
    if (!pending?.transactionHash) return Promise.resolve();
    if (pollRequest?.epoch === generation && pollRequest.intentId === pending.intentId && pollRequest.transactionHash === pending.transactionHash) return pollRequest.promise;
    const request = { epoch: generation, intentId: pending.intentId, transactionHash: pending.transactionHash };
    request.promise = reportPending(generation, ticket).finally(() => { if (pollRequest === request) pollRequest = undefined; });
    pollRequest = request; return request.promise;
  }
  function startPolling() {
    if (!wallet || !pending?.transactionHash || pollTimer || stopped) return Promise.resolve();
    if (pollRequest?.epoch === epoch && pollRequest.intentId === pending.intentId && pollRequest.transactionHash === pending.transactionHash) return pollRequest.promise;
    const ticket = ++pollEpoch; pollCount = 0; return performReport(epoch, ticket);
  }
  async function reconcile() {
    if (!wallet || !pending || busy || connecting || restoring || stopped) return;
    const transactionHash = $('[data-admin-reconcile-hash]')?.value.trim();
    if (!hash(transactionHash)) { feedback('pending', 'Enter the complete transaction hash from wallet activity.', true); return; }
    if (pending.hashValidated && pending.transactionHash && pending.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) { feedback('pending', 'Check the hash already validated for this request.', true); return; }
    savePending({ ...pending, transactionHash, ...(pending.transactionHash?.toLowerCase() === transactionHash.toLowerCase() ? {} : { hashValidated: false }) }); clearTimeout(pollTimer); pollTimer = undefined;
    busy = true; render(); try { await startPolling(); } finally { busy = false; render(); }
  }
  async function logout() {
    if (!wallet || busy || connecting || restoring) return;
    busy = true; render();
    try {
      await api('/api/test/logout', {}); epoch++; statusEpoch++; stopPolling();
      wallet = undefined; provider = undefined; status = undefined; draftLoaded = false; detachWallet?.(); invalidateReview(); feedback('wallet', 'Signed out.');
    } catch (error) { feedback('wallet', error.message, true); }
    finally { busy = false; render(); }
  }
  async function loadSession() {
    const generation = epoch;
    try {
      const session = await api('/api/test/session');
      if (generation !== epoch || stopped) return;
      if (typeof session.csrf !== 'string' || !session.csrf) throw Error('Wallet sign-in could not be initialized.');
      csrf = session.csrf; sessionReady = true; wallet = address(session.wallet) ? session.wallet : undefined;
      if (wallet) await Promise.all([restoreWallet(), refreshPolicy()]);
    } catch (error) { if (generation === epoch) feedback('wallet', error.message, true); }
    finally { render(); }
  }
  window.addEventListener('eip6963:announceProvider', event => {
    if (event.detail?.provider?.request && !providers.some(value => value.provider === event.detail.provider)) providers.push(event.detail);
    if (sessionReady && wallet && !provider) void restoreWallet();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  for (const name of ['wallets', 'quota']) $('[data-admin-' + name + ']')?.addEventListener('input', () => { draftEpoch++; invalidateReview('Draft changed. Review it again before applying.'); });
  $('[data-admin-end-ack]')?.addEventListener('change', render);
  for (const [name, handler] of [['connect', connect], ['logout', logout], ['refresh', refreshPolicy], ['review', reviewChanges], ['reconcile', reconcile]]) $('[data-admin-' + name + ']')?.addEventListener('click', handler);
  for (const action of ['pause', 'configure', 'unpause']) $('[data-admin-' + action + ']')?.addEventListener('click', () => act(action));
  window.addEventListener('pagehide', () => { stopped = true; epoch++; stopPolling(); detachWallet?.(); });
  window.addEventListener('pageshow', event => { if (event.persisted && !busy && !connecting && !restoring) { stopped = false; status = undefined; provider = undefined; epoch++; invalidateReview(); void loadSession(); } });
  restorePending(); render();
  const initialized = loadSession();
  return { initialized, connect, refresh: refreshPolicy, review: reviewChanges, act, reconcile, logout };
}

export const SEPOLIA_ADMIN_CLIENT = `(${sepoliaAdminClient.toString()})(${renderInlineFeedback.toString()});`;
