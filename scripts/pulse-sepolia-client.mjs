// Sepolia rehearsal only. The real release client and public admission gates
// are deliberately not repurposed by this disposable test surface.
import { mintHandleDraft } from '../src/openMint/mintHandleDraft.ts';
import { bindHandleValidation } from '../src/openMint/fieldValidation.ts';
import { renderInlineFeedback } from '../src/openMint/inlineFeedback.ts';
import { SEPOLIA_READ_BUDGETS } from './pulse-sepolia-read-budgets.mjs';
export function sepoliaTestClient(restoreHandleDraft, bindHandleValidation, renderInlineFeedback, readBudgets) {
  const $ = q => document.querySelector(q);
  bindHandleValidation(document);
  // A monitored signature is still a viewing surface unless the page is an
  // actual mint flow. Relay/RPC health is not a visitor-facing gallery notice.
  const mintProcess = !!($('[data-mint-entry]') || $('[data-assessment-code]') || $('[data-mint-process]'));
  let csrf, wallet, provider, watchedProvider, busy = false, connecting = false, restoring = false, sessionReady = false, connectionEpoch = 0, detachWalletEvents, priceRequest, mintQuote, saleGeneration = 0, saleFingerprint;
  let optionsRetryTimer, optionsRetryCount = 0, optionsFailed = false;
  let statusTimer, statusGeneration = 0, revealed, readReady = true, statusFailures = 0, statusFailureSince, statusIntegrity = false, pendingRecovery = false, terminalRequest = false;
  let recoveryHandle, recoveryRequest, pendingCache;
  const pendingReference = () => {
    let stored;
    try { stored = sessionStorage.getItem('sg-sepolia-pending'); }
    catch {
      if (pendingCache) return pendingCache.value;
      // Unreadable storage is not evidence that no submission exists.
      pendingRecovery = true;
      throw Object.assign(Error('Your saved mint could not be read. Enable browser storage, then refresh this page.'), { code: 'MINT_REFERENCE_STORAGE' });
    }
    // A failed write still needs a recoverable reference in this document.
    // A different persisted reference belongs to a newer attempt and wins.
    if (pendingCache && (!stored || stored === pendingCache.source)) return pendingCache.value;
    pendingCache = stored ? { source: stored, value: stored } : undefined; return stored;
  };
  function savePendingReference(value) {
    let source = pendingCache?.source;
    try { source = sessionStorage.getItem('sg-sepolia-pending'); sessionStorage.setItem('sg-sepolia-pending', value); pendingCache = { source: value, value }; return true; }
    catch { pendingCache = { source, value }; return false; }
  }
  function clearSavedMintReferences() {
    let pending, stored, reveal;
    try {
      pending = pendingReference(); stored = sessionStorage.getItem('sg-sepolia-pending'); reveal = sessionStorage.getItem('sg-sepolia-reveal');
      sessionStorage.removeItem('sg-sepolia-pending');
      sessionStorage.removeItem('sg-sepolia-reveal');
    } catch {
      // Restore a partially removed reference before reporting failure. Never
      // replace a different marker belonging to a newer stored attempt.
      let remaining, pendingReadable = false;
      try { remaining = sessionStorage.getItem('sg-sepolia-pending'); pendingReadable = true; } catch {}
      if (pending && (!remaining || remaining === stored)) {
        if (pendingReadable && !remaining && stored) { try { sessionStorage.setItem('sg-sepolia-pending', stored); } catch {} }
        let source = pendingCache?.source;
        try { source = sessionStorage.getItem('sg-sepolia-pending'); } catch {}
        pendingCache = { source, value: pending };
      }
      if (reveal) {
        try { if (!sessionStorage.getItem('sg-sepolia-reveal')) sessionStorage.setItem('sg-sepolia-reveal', reveal); } catch {}
      }
      throw Object.assign(Error('Your saved mint could not be cleared. Please check the previous mint again.'), { code: 'MINT_REFERENCE_STORAGE' });
    }
    pendingCache = undefined;
  }
  const feedback = (text, warning = false) => renderInlineFeedback($('[data-request-feedback]') || $('[data-mint-feedback]'), text, warning);
  const walletFeedback = (text, warning = false) => renderInlineFeedback($('[data-mint-feedback]'), text, warning);
  const moveObservationWarning = destination => {
    const warning = $('[data-mint-observation-warning]'), target = $(destination);
    if (!warning || !target) return;
    // Move the existing node, rather than cloning it: readiness and mint
    // confirmation keep one notice/owner, in whichever context is visible.
    target.insertBefore(warning, destination === '[data-mint-action-notice]' ? $('[data-request-feedback]') : null);
  };
  const observationWarning = text => {
    const warning = $('[data-mint-observation-warning]'), message = $('[data-mint-observation-message]');
    if (!mintProcess) text = undefined;
    if (warning && message) {
      message.textContent = text || ''; warning.hidden = !text;
      // The readiness monitor must not replace a transaction-specific notice
      // with an unrelated gallery/admission check during confirmation.
      if (text) warning.dataset.noticeOwner = 'mint-confirmation';
      else if (warning.dataset.noticeOwner === 'mint-confirmation') delete warning.dataset.noticeOwner;
    }
  };
  const revealFeedback = text => {
    const note = $('[data-mint-result-feedback]') || $('[data-reveal-feedback]');
    if (note) note.textContent = mintProcess ? text : '';
  };
  if (!mintProcess) observationWarning();
  async function api(path, body, timeoutMs = 0) {
    const controller = timeoutMs ? new AbortController() : undefined;
    let rejectAborted;
    const aborted = controller && new Promise((_, reject) => { rejectAborted = () => reject(controller.signal.reason); });
    controller?.signal.addEventListener('abort', rejectAborted, { once: true });
    const timer = controller && setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = (async () => {
        const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}, body: body ? JSON.stringify(body) : undefined, ...(controller ? { signal: controller.signal } : {}) });
        controller?.signal.throwIfAborted();
        const value = await response.json();
        controller?.signal.throwIfAborted();
        if (!response.ok) throw Object.assign(Error(value.error || 'The request could not be completed.'), { code: value.code, status: response.status }); return value;
      })();
      return await (aborted ? Promise.race([request, aborted]) : request);
    } catch (e) {
      if (controller?.signal.aborted) throw Error(path.startsWith('/api/test/status')
        ? 'Mint status could not be checked right now. Checking again shortly.' : path === '/api/test/options'
          ? 'Price could not be checked right now. Please try again.' : path === '/api/test/recover'
            ? 'The previous mint could not be checked right now. Please try again.' : 'Wallet verification timed out. Try connecting again.');
      throw e;
    } finally { if (controller) { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAborted); } }
  }
  const providers = [];
  const browserProvider = () => providers.find(p => p.provider.isRabby || p.info?.rdns === 'io.rabby')?.provider || window.ethereum || providers[0]?.provider;
  window.addEventListener('eip6963:announceProvider', event => {
    if (event.detail?.provider && !providers.some(p => p.provider === event.detail.provider)) providers.push(event.detail);
    if (sessionReady && wallet && !provider && !connecting && !restoring && !busy) void restoreWallet();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  function watchWallet(activeProvider) {
    detachWalletEvents?.(); watchedProvider = activeProvider;
    const changed = text => {
      if (watchedProvider !== activeProvider) return;
      cancelOptionsRetry(); optionsFailed = false;
      connectionEpoch++; wallet = undefined; provider = undefined;
      if (pendingRecovery && !revealed) {
        // A reconnect may start a new proof/status epoch. Responses from the
        // previous wallet proof must not release that newer submission lock.
        statusGeneration++; clearTimeout(statusTimer);
        // Recovery itself does not hold busy. An active wallet request/report
        // still does, and must settle before a competing reconnect can begin.
      }
      connected(); walletFeedback(text, true);
    };
    const accountChanged = () => changed('Wallet changed. Connect it again.');
    const chainChanged = () => changed('Network changed. Connect on Sepolia again.');
    const disconnected = () => changed('Wallet disconnected. Connect it again.');
    activeProvider.on?.('accountsChanged', accountChanged);
    activeProvider.on?.('chainChanged', chainChanged);
    activeProvider.on?.('disconnect', disconnected);
    detachWalletEvents = () => {
      activeProvider.removeListener?.('accountsChanged', accountChanged);
      activeProvider.removeListener?.('chainChanged', chainChanged);
      activeProvider.removeListener?.('disconnect', disconnected);
      if (watchedProvider === activeProvider) watchedProvider = undefined;
    };
  }
  async function restoreWallet() {
    if (!wallet || provider || restoring || connecting || busy || !$('[data-wallet-label]')) return;
    const activeProvider = browserProvider();
    if (!activeProvider) return; // A later EIP-6963 announcement may restore it.
    const savedWallet = wallet, epoch = connectionEpoch;
    restoring = true; connected();
    let timeout;
    try {
      watchWallet(activeProvider);
      // Read existing permissions only: never open a wallet prompt, switch
      // chains, create a challenge, sign, prepare or send during restoration.
      const [accounts, chainId] = await Promise.race([
        Promise.all([activeProvider.request({ method: 'eth_accounts' }), activeProvider.request({ method: 'eth_chainId' })]),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Wallet access could not be restored. Connect it again.')), 5000); }),
      ]);
      if (epoch !== connectionEpoch || wallet !== savedWallet) return;
      if (accounts?.[0]?.toLowerCase() !== savedWallet.toLowerCase()) throw Error('The selected wallet does not match your sign-in. Connect it again.');
      if (chainId?.toLowerCase() !== '0xaa36a7') throw Error('Choose Ethereum Sepolia in your wallet, then reconnect.');
      provider = activeProvider;
      walletFeedback('Wallet connected.');
      if ($('[data-pulse-options]')) {
        void options().then(() => {
          if (epoch === connectionEpoch && wallet === savedWallet) walletFeedback('Wallet connected.');
        }).catch(() => {}); // The price section owns its failure and recovery.
      }
    } catch (error) {
      if (epoch === connectionEpoch && wallet === savedWallet) walletFeedback(error.message || 'Wallet access could not be restored. Connect it again.', true);
    } finally {
      clearTimeout(timeout); restoring = false; connected();
      if (wallet && !provider && browserProvider() !== activeProvider) void restoreWallet();
    }
  }
  async function chain() {
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() !== '0xaa36a7') {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    }
    if ((await provider.request({ method: 'eth_chainId' })).toLowerCase() !== '0xaa36a7') throw Error('Choose Ethereum Sepolia in your wallet.');
  }
  function connected() {
    const label = $('[data-wallet-label]'); if (label) label.textContent = wallet || ($('[data-mint-entry]') ? '' : 'Connect the wallet that will receive the token.');
    // The span owns the shared button border/padding. Replacing the button's
    // textContent removes that styled element and turns it into bare text.
    const connectLabel = $('[data-connect-wallet] > span'); if (connectLabel) connectLabel.textContent = restoring ? 'Restoring wallet…' : connecting ? 'Connecting…' : wallet ? provider ? 'Change wallet' : 'Reconnect wallet' : 'Connect wallet';
    const button = $('[data-connect-wallet]'); if (button) button.disabled = connecting || restoring || !sessionReady || busy;
    const checkingPrice = priceRequest?.epoch === connectionEpoch && priceRequest.wallet === wallet && priceRequest.saleGeneration === saleGeneration;
    const phase = $('[data-pulse-options]')?.dataset.pulsePhase;
    const refreshVisible = phase === 'paid' || optionsFailed && !optionsRetryTimer && !checkingPrice;
    const refresh = $('[data-pulse-check]'), refreshActions = $('[data-pulse-refresh]');
    if (refresh) refresh.hidden = !refreshVisible;
    if (refreshActions) refreshActions.hidden = !refreshVisible;
    const priceButton = $('[data-pulse-check]'); if (priceButton) priceButton.disabled = !!checkingPrice;
    const priceLabel = $('[data-pulse-check] > span'); if (priceLabel) priceLabel.textContent = checkingPrice ? phase === 'paid' ? 'Checking price…' : 'Checking…' : phase === 'paid' ? 'Refresh price' : 'Try again';
    const quoteReady = mintQuote?.epoch === connectionEpoch && mintQuote.wallet === wallet && mintQuote.available;
    const submit = $('[data-request-submit]'); if (submit) submit.disabled = !wallet || !provider || busy || pendingRecovery || terminalRequest || !!revealed || connecting || restoring || !readReady || !!$('[data-pulse-options]') && (!quoteReady || !ceilingReady());
    const checkingRecovery = recoveryRequest?.epoch === connectionEpoch && recoveryRequest.generation === statusGeneration;
    for (const [selector, label] of [['[data-mint-recovery-check]', 'Check previous mint'], ['[data-mint-recovery-transaction]', 'Check transaction']]) {
      const button = $(selector), span = $(selector + ' > span');
      if (button) button.disabled = !!checkingRecovery;
      if (span) span.textContent = checkingRecovery && recoveryRequest.selector === selector ? 'Checking…' : label;
    }
  }
  function ethToWei(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)) return;
    const [whole, decimal = ''] = value.split('.');
    return BigInt(whole) * 1000000000000000000n + BigInt(decimal.padEnd(18, '0'));
  }
  function ceilingReady() {
    if (mintQuote?.phase !== 'paid') return true;
    const cap = ethToWei($('[name="pulse-max-eth"]')?.value);
    return cap !== undefined && cap > 0n && cap <= 100000000000000n && cap >= mintQuote.priceWei;
  }
  function cancelOptionsRetry() { clearTimeout(optionsRetryTimer); optionsRetryTimer = undefined; }
  function presentSale(status, notice, observed = false) {
    const section = $('[data-pulse-options]');
    if (!section || !status) return;
    const phase = ['free', 'paid'].includes(status.phase) ? status.phase : 'unknown';
    if (observed) {
      const fingerprint = JSON.stringify([phase, status.paused === true, status.freeMinted, status.freeMintQuota, status.freeConfigRevision]);
      if (fingerprint !== saleFingerprint) { saleFingerprint = fingerprint; saleGeneration++; cancelOptionsRetry(); optionsFailed = false; }
    }
    section.dataset.pulsePhase = phase;
    const title = $('[data-pulse-title]'); if (title) title.textContent = phase === 'free' ? 'Free Mint' : phase === 'paid' ? 'Mint price' : 'Mint availability';
    const paid = $('[data-pulse-paid]'), free = $('[data-pulse-free]');
    if (paid) paid.hidden = phase !== 'paid';
    if (free) free.hidden = phase !== 'free';
    const refresh = $('[data-pulse-check]'); if (refresh) refresh.hidden = phase !== 'paid';
    const refreshActions = $('[data-pulse-refresh]'); if (refreshActions) refreshActions.hidden = phase !== 'paid';
    const sale = $('[data-pulse-sale-status]');
    if (sale) {
      if (notice) sale.textContent = notice;
      else if (status.paused) sale.textContent = 'Minting is paused.';
      else if (Number.isInteger(status.freeMinted) && Number.isInteger(status.freeMintQuota)) sale.textContent = `${phase === 'free' ? 'Free mint open' : phase === 'paid' ? 'Free mint ended' : 'Checking mint availability…'} · ${status.freeMinted}/${status.freeMintQuota} slots used.`;
      else sale.textContent = phase === 'unknown' ? 'Checking mint availability…' : '';
    }
    // Public phase presentation is not wallet eligibility or mint authority.
    // A changed phase/paused sale must invalidate the old wallet quote before
    // an automatic replacement read settles.
    if (mintQuote && (mintQuote.phase !== phase || status.paused)) {
      mintQuote = undefined;
      if (observed) renderInlineFeedback($('[data-pulse-feedback]'), status.paused ? 'Minting is paused.' : 'Checking mint availability…');
    }
    const mode = $('[name="pulse-mode"]');
    if (mode && !mintQuote) mode.value = '';
    const cap = $('[name="pulse-max-eth"]');
    if (cap) cap.disabled = phase !== 'paid' || status.paused === true || !mintQuote?.available;
  }
  function showRecovery(handle) {
    const previousHandle = recoveryHandle, hash = $('[name="mint-recovery-hash"]');
    if (hash && previousHandle !== handle) hash.value = '';
    if (!handle) renderInlineFeedback($('[data-mint-recovery-feedback]'), '');
    recoveryHandle = handle;
    const section = $('[data-mint-recovery]'); if (section) section.hidden = !handle;
    const label = $('[data-mint-recovery-handle]'); if (label) label.textContent = handle ? '@' + handle : '';
    if (!handle) return;
    try {
      const marker = savedMintReference(pendingReference() || sessionStorage.getItem('sg-sepolia-reveal'));
      if (hash && !hash.value && marker?.handle === handle && /^0x[a-f0-9]{64}$/i.test(marker.transactionHash || '')) hash.value = marker.transactionHash;
    } catch {} // Invalid storage keeps the submission guard in place.
  }
  function recoverPreviousMint(withHash = false) {
    if (recoveryRequest?.epoch === connectionEpoch && recoveryRequest.generation === statusGeneration) return recoveryRequest.promise;
    const note = $('[data-mint-recovery-feedback]'), handle = recoveryHandle;
    if (!pendingRecovery || revealed || !handle) return Promise.resolve();
    const rawReference = pendingReference() || sessionStorage.getItem('sg-sepolia-reveal');
    let reference;
    try { reference = savedMintReference(rawReference); } catch (error) { renderInlineFeedback(note, error.message, true); return Promise.resolve(); }
    if (!wallet || !provider || connecting || restoring || reference?.handle !== handle
      || reference.wallet && reference.wallet.toLowerCase() !== wallet.toLowerCase()) {
      renderInlineFeedback(note, 'Reconnect the wallet used for this mint, then check again.', true); return Promise.resolve();
    }
    const transactionHash = withHash ? $('[name="mint-recovery-hash"]')?.value.trim() : undefined;
    if (withHash && !/^0x[a-f0-9]{64}$/i.test(transactionHash || '')) {
      renderInlineFeedback(note, 'Enter the transaction hash from your wallet activity.', true); return Promise.resolve();
    }
    statusGeneration++; clearTimeout(statusTimer);
    const request = { epoch: connectionEpoch, generation: statusGeneration, wallet, handle,
      selector: withHash ? '[data-mint-recovery-transaction]' : '[data-mint-recovery-check]' };
    const current = () => request.epoch === connectionEpoch && request.generation === statusGeneration && wallet === request.wallet
      && pendingRecovery && !revealed && recoveryHandle === handle
      && (pendingReference() || sessionStorage.getItem('sg-sepolia-reveal')) === rawReference;
    recoveryRequest = request; connected(); renderInlineFeedback(note, 'Checking your previous mint…');
    request.promise = (async () => {
      try {
        const value = await api('/api/test/recover', { handle, ...(reference.code ? { attemptCode: reference.code } : {}), ...(transactionHash ? { transactionHash } : {}) }, readBudgets.browserMs);
        if (!current()) return;
        if (value.handle !== handle || reference.code && value.attemptCode !== reference.code) throw Error('The previous mint could not be verified. Please try again.');
        if (value.state === 'retry-allowed') {
          if (value.submissionStage !== 'expired' || value.recoveryWallet?.toLowerCase() !== wallet.toLowerCase()) throw Error('The previous mint could not be verified. Please try again.');
          // Only the authenticated recovery endpoint can authorize another
          // mint after an ambiguous send. Wallet errors and elapsed time do not.
          clearSavedMintReferences();
          statusGeneration++; clearTimeout(statusTimer);
          statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false;
          pendingRecovery = false; terminalRequest = false; busy = false; showRecovery(); observationWarning();
          renderInlineFeedback(note, ''); feedback('The previous mint did not complete. You can mint when ready.'); connected();
          const queued = $('[data-mint-retry-note]'); if (queued) queued.hidden = false;
          return;
        }
        if (value.state === 'submission-unknown') {
          renderInlineFeedback(note, 'The previous mint is still unconfirmed. Check its transaction hash or check again later.');
          statusTimer = setTimeout(() => void poll(handle), 5000); return;
        }
        if (!['pending', 'confirming', 'minted', 'reverted'].includes(value.state) || !/^0x[a-f0-9]{64}$/i.test(value.transactionHash || '')) throw Error('The previous mint could not be verified. Please try again.');
        // Retain verified wallet/chain/collection scope along with a hash. A
        // hash alone does not unlock submission or expose a signature.
        if (pendingReference()) savePendingReference(JSON.stringify({ ...reference, transactionHash: value.transactionHash }));
        renderInlineFeedback(note, '');
        if (value.state === 'reverted') await poll(handle, value);
        else { showRecovery(); await poll(handle); }
      } catch (error) {
        if (current()) {
          renderInlineFeedback(note, error.message || 'The previous mint could not be checked right now. Please try again.', true);
          statusTimer = setTimeout(() => void poll(handle), 5000);
        }
      } finally { if (recoveryRequest === request) { recoveryRequest = undefined; connected(); } }
    })();
    return request.promise;
  }
  function options(retry = false) {
    const selectedWallet = wallet, epoch = connectionEpoch;
    if (!wallet) {
      const error = Error('Connect your wallet first.');
      renderInlineFeedback($('[data-pulse-feedback]'), error.message, true);
      return Promise.reject(error);
    }
    // A quote is read-only, independent of saved-mint recovery. Coalesce
    // repeated clicks/automatic checks for this proof without freezing wallet
    // controls or letting an old wallet's response overwrite a newer quote.
    if (priceRequest?.epoch === epoch && priceRequest.wallet === selectedWallet && priceRequest.saleGeneration === saleGeneration) return priceRequest.promise;
    cancelOptionsRetry(); if (!retry) optionsRetryCount = 0;
    optionsFailed = false;
    const request = { epoch, wallet: selectedWallet, saleGeneration };
    priceRequest = request; connected();
    renderInlineFeedback($('[data-pulse-feedback]'), $('[data-pulse-options]')?.dataset.pulsePhase === 'paid' ? 'Checking price…' : 'Checking your free mint eligibility…');
    request.promise = (async () => {
      try {
        const result = await api('/api/test/options', undefined, readBudgets.browserMs);
        if (epoch !== connectionEpoch || wallet !== selectedWallet || request.saleGeneration !== saleGeneration) return;
        const phase = result.phase || result.saleStatus?.phase || (result.free ? 'free' : result.paid ? 'paid' : 'unknown');
        if (!['free', 'paid'].includes(phase) || typeof result.free !== 'boolean' || typeof result.paid !== 'boolean'
          || result.saleStatus?.phase && result.saleStatus.phase !== phase
          || result.free && (phase !== 'free' || result.paid) || result.paid && phase !== 'paid') throw Object.assign(Error('Mint availability could not be verified. Please try again shortly.'), { code: 'MINT_QUOTE_INVALID' });
        const priceWei = phase === 'paid' ? typeof result.priceWei === 'string' && /^(0|[1-9][0-9]*)$/.test(result.priceWei) ? BigInt(result.priceWei) : ethToWei(result.priceETH) : undefined;
        if (phase === 'paid' && (priceWei === undefined || priceWei < 0n)) throw Object.assign(Error('Mint price could not be verified. Please try again shortly.'), { code: 'MINT_QUOTE_INVALID' });
        const status = { ...result.saleStatus, phase, paused: result.paused === true || result.saleStatus?.paused === true };
        presentSale(status, result.saleNotice);
        mintQuote = { epoch, wallet: selectedWallet, phase, priceWei, available: !status.paused && (phase === 'free' ? result.free === true : result.paid === true) };
        optionsRetryCount = 0;
        const mode = $('[name="pulse-mode"]'), cap = $('[name="pulse-max-eth"]');
        if (mode) mode.value = mintQuote.available ? phase : '';
        if (cap) cap.disabled = !mintQuote.available || phase !== 'paid';
        renderInlineFeedback($('[data-pulse-feedback]'), status.paused ? 'Minting is paused.' : phase === 'free' ? result.free
          ? 'You have an unused free mint slot. You pay network gas.' : 'This wallet has no available free mint slot. Paid minting begins when the free phase ends.'
          : result.paid ? `Current Pulse price: ${result.priceETH} Sepolia ETH. Choose a ceiling; unused payment is refunded.` : 'Paid minting is not available right now.');
      } catch (error) {
        if (epoch === connectionEpoch && wallet === selectedWallet && request.saleGeneration === saleGeneration) {
          mintQuote = undefined;
          const mode = $('[name="pulse-mode"]'), cap = $('[name="pulse-max-eth"]');
          if (mode) mode.value = '';
          if (cap) cap.disabled = true;
          optionsFailed = true;
          renderInlineFeedback($('[data-pulse-feedback]'), error.message, true);
          const transient = (!error.code && !error.status || ['OBSERVATION_UNAVAILABLE', 'RPC_DATA_UNAVAILABLE'].includes(error.code)) && error.status !== 401 && error.status !== 403;
          if (transient && optionsRetryCount < 2 && wallet && provider && readReady) {
            const retryProvider = provider, retryGeneration = saleGeneration, retryEpoch = connectionEpoch;
            const delay = ++optionsRetryCount * 10000;
            optionsRetryTimer = setTimeout(() => {
              optionsRetryTimer = undefined;
              if (retryEpoch !== connectionEpoch || retryGeneration !== saleGeneration || wallet !== selectedWallet || provider !== retryProvider || !readReady) { connected(); return; }
              void options(true).catch(() => {});
            }, delay);
          }
        }
        throw error;
      } finally {
        if (priceRequest === request) { priceRequest = undefined; connected(); }
      }
    })();
    return request.promise;
  }
  async function connect() {
    if (connecting || restoring || busy) return;
    connecting = true; wallet = undefined; provider = undefined; detachWalletEvents?.();
    cancelOptionsRetry(); optionsFailed = false;
    connectionEpoch++;
    if (pendingRecovery) { statusGeneration++; clearTimeout(statusTimer); }
    connected(); walletFeedback('Opening your wallet…');
    try {
      await session;
      if (!sessionReady) throw Error('Sign-in could not be initialized. Refresh the page and try again.');
      provider = browserProvider();
      if (!provider) throw Error('Open this page in a browser with an Ethereum wallet connected to Sepolia.');
      await chain();
      const activeProvider = provider;
      watchWallet(activeProvider);
      const accounts = await activeProvider.request({ method: 'eth_requestAccounts' });
      // Some wallets emit accountsChanged while granting access. Start the
      // proof against the granted account, then reject later changes.
      if (!accounts[0]) throw Error('No wallet account was selected.');
      const proofEpoch = connectionEpoch;
      const assertCurrent = async () => {
        if (proofEpoch !== connectionEpoch) throw Error('Wallet changed. Connect it again.');
        const current = await activeProvider.request({ method: 'eth_accounts' });
        const currentChain = await activeProvider.request({ method: 'eth_chainId' });
        if (proofEpoch !== connectionEpoch || current[0]?.toLowerCase() !== accounts[0].toLowerCase() || currentChain.toLowerCase() !== '0xaa36a7') throw Error('Wallet or network changed. Connect it again.');
      };
      walletFeedback('Checking this account on Sepolia…');
      const challenge = await api('/api/test/challenge', { address: accounts[0] }, readBudgets.browserMs);
      await assertCurrent();
      walletFeedback('Confirm the sign-in message in your wallet. This does not mint or spend ETH.');
      const message = '0x' + [...new TextEncoder().encode(challenge.message)].map(n => n.toString(16).padStart(2, '0')).join('');
      const signature = await activeProvider.request({ method: 'personal_sign', params: [message, accounts[0]] });
      await assertCurrent();
      walletFeedback('Verifying your sign-in…');
      const verified = await api('/api/test/verify', { challengeId: challenge.challengeId, signature }, readBudgets.browserMs);
      await assertCurrent();
      if (verified.wallet?.toLowerCase() !== accounts[0].toLowerCase()) throw Error('Wallet verification did not match the selected account. Connect it again.');
      wallet = verified.wallet; provider = activeProvider;
      if ($('[data-collection-page]')) { location.reload(); return; }
      if (pendingRecovery) {
        // Wallet proof succeeded independently of the previous mint's status.
        // Recovery progress/results belong beside the mint CTA, not here.
        walletFeedback('Wallet connected.');
        const pending = pendingReference(), priorReveal = sessionStorage.getItem('sg-sepolia-reveal');
        if (pending || priorReveal) resumeSavedMint(savedMintReference(pending || priorReveal), !pending);
        void options().catch(() => {});
        connected(); return;
      }
      walletFeedback('Wallet connected.');
      try { await options(); } catch {} // Already shown beside the phase controls.
      if (proofEpoch === connectionEpoch) walletFeedback('Wallet connected.');
    } catch (e) {
      walletFeedback(e.code === 4001 ? 'Wallet sign-in was cancelled. Connect again when ready.' : e.message, e.code !== 4001);
    } finally { connecting = false; connected(); }
  }
  async function poll(handle, verifiedFailedReceipt) {
    const generation = statusGeneration, epoch = connectionEpoch;
    const rawReference = pendingReference() || sessionStorage.getItem('sg-sepolia-reveal');
    let again = true;
    try {
      const value = verifiedFailedReceipt || await api('/api/test/status?handle=' + encodeURIComponent(handle), undefined, readBudgets.browserMs);
      if (generation !== statusGeneration) return;
      if (value.handle !== handle || !['not-submitted', 'retry-allowed', 'submission-unknown', 'pending', 'confirming', 'minted', 'reverted'].includes(value.state)) throw Error('Mint status could not be verified. Checking again shortly.');
      if (value.state === 'pending' && !/^0x[a-f0-9]{64}$/i.test(value.transactionHash || '')) throw Error('Mint status could not be verified. Checking again shortly.');
      if (value.state === 'not-submitted' || value.state === 'retry-allowed') {
        if (revealed) throw Object.assign(Error('Previously verified mint evidence changed.'), { code: 'MINT_EVIDENCE_CONFLICT' });
        const retryAllowed = value.state === 'retry-allowed';
        if (!(retryAllowed ? ['expired'] : ['none', 'prepared']).includes(value.submissionStage) || !wallet
          || value.recoveryWallet?.toLowerCase() !== wallet.toLowerCase() || epoch !== connectionEpoch
          || rawReference !== (pendingReference() || sessionStorage.getItem('sg-sepolia-reveal'))) throw Error('The saved submission could not be verified.');
        const reference = savedMintReference(rawReference);
        if (!retryAllowed && value.submissionStage === 'prepared' && reference?.requiresRecovery) {
          // An explicit prepare failure can discover an expired backend
          // request after local storage was cleared. It still needs the
          // recovery endpoint to retire that authorization before retrying.
          showRecovery(handle); observationWarning();
          feedback('The previous mint request needs to be resolved before continuing.');
          again = false; return;
        }
        if (retryAllowed) {
          if (!pendingRecovery || !reference || reference.handle !== handle || reference.code && value.attemptCode !== reference.code
            || reference.wallet && reference.wallet.toLowerCase() !== wallet.toLowerCase()) throw Error('The saved submission could not be verified.');
        }
        // Only authenticated backend proof that submission never began may
        // release an obsolete reference. A timeout, age or missing receipt
        // must never turn an ambiguous broadcast into another submission.
        clearSavedMintReferences();
        statusGeneration++; clearTimeout(statusTimer);
        statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false;
        observationWarning(); pendingRecovery = false; terminalRequest = false; busy = false; connected();
        showRecovery();
        feedback(retryAllowed ? 'The previous mint did not complete. You can mint when ready.' : 'No mint was submitted. You can continue when ready.');
        const queued = $('[data-mint-retry-note]'); if (queued) queued.hidden = !retryAllowed;
        await restoreWallet(); again = false; return;
      }
      if (value.state === 'submission-unknown') {
        if (revealed) throw Object.assign(Error('Previously verified mint evidence changed.'), { code: 'MINT_EVIDENCE_CONFLICT' });
        statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false;
        observationWarning('Submission could not be confirmed. Check your wallet activity before trying again.');
        feedback('No new mint will be submitted automatically.');
        showRecovery(handle);
        return;
      }
      if (value.state === 'reverted') {
        if (!/^0x[a-f0-9]{64}$/i.test(value.transactionHash || '')) throw Error('Mint status could not be verified. Checking again shortly.');
        const message = 'The mint transaction failed on Sepolia. No token was minted by this transaction. No new mint will be submitted automatically.';
        if (revealed) {
          const badge = $('[data-mint-state-label]'); if (badge) badge.textContent = 'Mint failed';
          const article = $('.signature-page'); if (article) article.dataset.mintState = 'reverted';
          observationWarning(message);
          revealFeedback('This is your previously revealed signature.');
        } else {
          observationWarning(message); feedback('');
          statusGeneration++; clearTimeout(statusTimer);
          // A failed receipt does not retire a still-valid authorization: a
          // queued copy could still be sent. Keep this reference available
          // until explicit finalized expiry/unused proof authorizes retry.
          pendingRecovery = true; terminalRequest = true; busy = false; showRecovery(handle); connected(); await restoreWallet();
          // This server request is terminal. Changing wallet is safe, but
          // another send must never retry the same reverted request silently.
          const submit = $('[data-request-submit]'); if (submit) submit.disabled = true;
        }
        statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false;
        again = false; return;
      }
      if (value.state === 'confirming' || value.state === 'minted') {
        if (!/^[1-9][0-9]{0,77}$/.test(value.tokenId || '') || BigInt(value.tokenId) >= 2n ** 256n || !/^0x[a-f0-9]{64}$/i.test(value.transactionHash || '')
          || !/^0x[a-f0-9]{64}$/i.test(value.inputDigest || '') || !/^0x[a-f0-9]{64}$/i.test(value.rendererIdentity || '')
          || value.url !== '/signatures/' + handle || typeof value.html !== 'string' || value.html.length > 65536
          || !value.html.startsWith('<article class="signature-page"') || !value.html.includes('data-mint-state="' + value.state + '"')
          || value.observationUnavailable !== undefined && typeof value.observationUnavailable !== 'boolean'
          || value.state === 'confirming' && value.observationUnavailable
          || (revealed && ['tokenId', 'inputDigest', 'rendererIdentity'].some(key => revealed[key] !== value[key]))) throw Object.assign(Error('The revealed signature could not be verified. Checking again shortly.'), { code: 'MINT_EVIDENCE_CONFLICT' });
        const result = $('[data-mint-result]'), art = $('[data-mint-result-artwork]');
        if (result && art) {
          const first = !revealed;
          // Only a server-validated inclusion can supply this shared markup.
          // A wallet hash, preparation response or storage flag cannot reveal.
          if (first || revealed.state !== value.state) art.innerHTML = value.html;
          moveObservationWarning('[data-mint-result-notice]');
          $('[data-assessment-request]').hidden = true;
          result.hidden = false;
          $('[data-mint-result-link]')?.setAttribute('href', value.url);
          renderInlineFeedback($('[data-mint-result-feedback]'), '');
          const badge = $('[data-mint-result] [data-mint-state-label]');
          if (badge) badge.textContent = value.state === 'minted' ? 'Minted' : 'Confirming';
          if (first) { result.focus?.({ preventScroll: true }); result.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }
          // Validated inclusion is already viewing evidence. A local cache
          // failure cannot undo it or strand the explicit next-mint action.
          revealed = value;
          try { sessionStorage.setItem('sg-sepolia-reveal', JSON.stringify({ handle })); }
          catch { renderInlineFeedback($('[data-mint-result-feedback]'), 'Your signature is revealed. Its viewing reference could not be saved in this browser.', true); }
        } else {
          const detail = $('.signature-page');
          if (detail && (!revealed || revealed.state !== value.state)) {
            // The shared fragment has a warning slot, while the full page owns
            // the single mounted notice. Preserve that mount across updates.
            const warning = mintProcess ? $('[data-mint-observation-warning]') : undefined;
            detail.outerHTML = value.html.replace('<!--mint-observation-warning-->', warning?.outerHTML || '');
          }
          const badge = $('[data-mint-state-label]');
          if (badge) badge.textContent = value.state === 'minted' ? 'Minted' : 'Confirming';
          revealFeedback(value.state === 'minted' ? '' : 'Your signature is revealed and visible in the gallery. The mint succeeded and is still confirming.');
        }
        const article = $('.signature-page'); if (article) article.dataset.mintState = value.state;
        // Once finalized, stale observation health is no longer an actionable
        // problem for this completed mint. Keep the verified image/status.
        observationWarning();
        revealed = value;
        pendingRecovery = false;
        showRecovery();
        sessionStorage.removeItem('sg-sepolia-pending');
        pendingCache = undefined;
        again = value.state !== 'minted' || value.observationUnavailable === true;
      } else if (revealed) {
        // Keep the already revealed image, with an honest noncanonical status.
        const badge = $('[data-mint-state-label]'); if (badge) badge.textContent = 'Rechecking mint';
        const article = $('.signature-page'); if (article) article.dataset.mintState = 'rechecking';
        observationWarning('This mint needs to be rechecked before it can be confirmed. Do not submit another mint.');
        revealFeedback('This is your previously revealed signature. Its mint is no longer verified in the current chain. Checking again; do not submit another mint.');
      } else {
        showRecovery();
        observationWarning();
        const warning = $('[data-mint-observation-warning]'); if (mintProcess && warning) warning.dataset.noticeOwner = 'mint-confirmation';
        feedback('Transaction submitted. Waiting for verified Sepolia inclusion…');
      }
      statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false;
    } catch (error) {
      if (generation !== statusGeneration) return;
      if (error.code === 'MINT_REFERENCE_STORAGE') {
        showRecovery(handle); renderInlineFeedback($('[data-mint-recovery-feedback]'), error.message, true);
      }
      statusFailures++; statusFailureSince ??= Date.now();
      const integrity = statusIntegrity || error.code === 'MINT_EVIDENCE_CONFLICT' || error.code === 'RPC_EVIDENCE_CONFLICT';
      statusIntegrity = integrity;
      const sustained = integrity || statusFailures >= 3 && Date.now() - statusFailureSince >= 15000;
      if (revealed) {
        const article = $('.signature-page');
        const finalized = revealed.state === 'minted' && article?.dataset.mintState === 'minted' && !integrity;
        // Failed refreshes do not alter the relay's last verified viewing
        // facts. An actual evidence conflict still withdraws a disputed label.
        const preserveViewedState = !mintProcess && !integrity;
        if (!preserveViewedState && sustained) {
          const badge = $('[data-mint-state-label]'); if (badge) badge.textContent = finalized ? 'Minted' : 'Status unavailable';
          if (article && !finalized) article.dataset.mintState = 'unknown';
        }
        observationWarning(finalized || !sustained ? undefined : integrity
          ? 'Previously verified mints need to be checked before minting can continue.'
          : 'Your signature is revealed, but confirmation could not be checked. Please do not submit another mint.');
        revealFeedback(finalized ? '' : 'Your signature remains revealed. Checking confirmation again; no new mint will be submitted.');
      } else {
        observationWarning(sustained ? integrity
          ? 'Mint transaction evidence could not be verified. Check your wallet activity before trying again.'
          : 'Mint transaction status could not be checked. Check your wallet activity before trying again.' : undefined);
        const warning = $('[data-mint-observation-warning]'); if (mintProcess && warning) warning.dataset.noticeOwner = 'mint-confirmation';
        feedback('Checking your mint transaction again. No new mint will be submitted automatically.');
      }
    } finally {
      if (again && generation === statusGeneration) statusTimer = setTimeout(() => void poll(handle), 5000);
    }
  }
  $('[data-connect-wallet]')?.addEventListener('click', connect);
  $('[data-disconnect-wallet]')?.addEventListener('click', () => api('/api/test/logout', {}).then(() => location.reload()).catch(e => feedback(e.message, true)));
  $('[data-pulse-check]')?.addEventListener('click', () => options().catch(() => {}));
  $('[name="pulse-max-eth"]')?.addEventListener('input', connected);
  $('[data-mint-recovery-check]')?.addEventListener('click', () => recoverPreviousMint());
  $('[data-mint-recovery-transaction]')?.addEventListener('click', () => recoverPreviousMint(true));
  $('[data-mint-another]')?.addEventListener('click', () => {
    if (!revealed) return;
    try { clearSavedMintReferences(); }
    catch (error) {
      renderInlineFeedback($('[data-mint-result-feedback]'), error.message, true); connected(); return;
    }
    statusGeneration++; clearTimeout(statusTimer); revealed = undefined; statusFailures = 0; statusFailureSince = undefined; statusIntegrity = false; pendingRecovery = false; terminalRequest = false;
    showRecovery();
    moveObservationWarning('[data-mint-action-notice]');
    $('[data-mint-result]').hidden = true; $('[data-mint-result-artwork]').innerHTML = '';
    observationWarning();
    $('[data-assessment-request]').hidden = false; busy = false; feedback('');
    session = loadSession(); // Recheck the existing proof; never sign or send.
  });
  $('[data-copy-handoff]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText($('[data-handoff-prompt]').value); renderInlineFeedback($('[data-copy-feedback]'), 'Copied.'); } catch { renderInlineFeedback($('[data-copy-feedback]'), 'Select and copy the prompt.', true); } });
  const handleInput = $('[name="handle"]');
  const saveHandleDraft = restoreHandleDraft(handleInput);
  const updateHandle = () => {
    saveHandleDraft();
    const h = (handleInput?.value || '').trim().replace(/^@/, ''), link = $('[data-mint-preview]');
    if (/^[A-Za-z0-9_]{1,15}$/.test(h)) link?.setAttribute('href', '/p/' + h + '/variations');
    else link?.removeAttribute('href');
  };
  handleInput?.addEventListener('input', updateHandle);
  updateHandle();
  $('[data-assessment-request]')?.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || pendingRecovery || terminalRequest || revealed || connecting || restoring || !readReady) return;
    if (handleInput?.checkValidity && !handleInput.checkValidity()) return;
    statusGeneration++; clearTimeout(statusTimer);
    const queued = $('[data-mint-retry-note]'); if (queued) queued.hidden = true;
    const submissionEpoch = connectionEpoch, submissionWallet = wallet;
    let attemptedHandle;
    busy = true; connected();
    try {
      if (!provider || !wallet) throw Error('Connect your wallet again.');
      await chain(); const current = await provider.request({ method: 'eth_accounts' });
      if (current[0]?.toLowerCase() !== wallet.toLowerCase()) throw Error('Wallet changed. Connect again.');
      const handle = $('[name="handle"]').value, mode = mintQuote?.epoch === connectionEpoch && mintQuote.wallet === wallet && mintQuote.available ? mintQuote.phase : undefined;
      attemptedHandle = handle.trim().replace(/^@/, '').toLowerCase();
      if (!mode) throw Error('Mint availability is being checked. Please try again shortly.');
      if (mode === 'paid' && !ceilingReady()) throw Error('Enter a maximum mint price at or above the current price.');
      feedback('Preparing your signature…');
      const plan = await api('/api/test/prepare', { handle, mode, maximumETH: mode === 'paid' ? $('[name="pulse-max-eth"]').value : '0' });
      if (plan.transaction.chainId !== '0xaa36a7' || plan.transaction.from.toLowerCase() !== wallet.toLowerCase()
        || plan.transaction.to.toLowerCase() !== document.body.dataset.contract.toLowerCase()) throw Error('Transaction binding changed; nothing was submitted.');
      await chain();
      await api('/api/test/begin', { code: plan.code });
      pendingRecovery = true;
      const marker = { version: 1, handle: plan.handle, wallet, chainId: 11155111, contract: document.body.dataset.contract, code: plan.code };
      if (!savePendingReference(JSON.stringify(marker))) {
        showRecovery(plan.handle);
        throw Error('Your mint was not sent because its recovery details could not be saved. Check the previous mint before trying again.');
      }
      feedback('Confirm the Sepolia mint in your wallet.');
      let hash;
      try { hash = await provider.request({ method: 'eth_sendTransaction', params: [plan.transaction] }); }
      catch (e) {
        // Even an error may have followed broadcast. No automatic resend.
        observationWarning('Submission could not be confirmed. Check your wallet activity before trying again.');
        feedback('No new mint will be submitted automatically.');
        showRecovery(plan.handle);
        busy = false; connected();
        return;
      }
      // Save the wallet's hash before reporting it. A lost report response or
      // reload must leave enough information for an explicit recovery check.
      if (/^0x[a-f0-9]{64}$/i.test(hash || '') && !savePendingReference(JSON.stringify({ ...marker, transactionHash: hash }))) {
        showRecovery(plan.handle);
        renderInlineFeedback($('[data-mint-recovery-feedback]'), 'The transaction hash could not be saved in this browser. Check the previous mint before leaving this page.', true);
      }
      try { await api('/api/test/report', { code: plan.code, transactionHash: hash }); }
      catch { feedback('Transaction submitted. Checking its status; no new mint will be submitted automatically.'); }
      // The wallet request/report has settled. Only the durable recovery guard
      // must remain while status is checked; read-only controls can be used.
      busy = false; connected();
      await poll(plan.handle);
    } catch (e) {
      busy = false;
      if (!pendingRecovery && !revealed && ['SUBMISSION_STARTED', 'REQUEST_EXPIRED'].includes(e.code)
        && wallet && provider && wallet === submissionWallet && connectionEpoch === submissionEpoch
        && /^[a-z0-9_]{1,15}$/.test(attemptedHandle || '')) {
        // Discover the existing request only after this explicit mint action
        // hit its backend guard. Typing or connecting never probes handles.
        savePendingReference(JSON.stringify({ version: 1, handle: attemptedHandle, wallet,
          chainId: 11155111, contract: document.body.dataset.contract, requiresRecovery: true }));
        pendingRecovery = true; showRecovery(attemptedHandle); connected();
        feedback('Checking your previous mint…'); await poll(attemptedHandle); return;
      }
      connected(); feedback(e.message, true);
    }
  });
  connected();
  function savedMintReference(value) {
    try { return JSON.parse(value); }
    catch { throw Error('The saved mint reference could not be checked.'); }
  }
  function resumeSavedMint(reference, publicReveal = false) {
    const handle = reference?.handle;
    if (!/^[a-z0-9_]{1,15}$/.test(handle || '')) throw Error('The saved mint reference could not be checked.');
    pendingRecovery = true;
    statusGeneration++; clearTimeout(statusTimer);
    if (!wallet && !publicReveal || reference.version !== undefined && (reference.version !== 1 || reference.chainId !== 11155111
      || reference.contract?.toLowerCase() !== document.body.dataset.contract.toLowerCase()
      || reference.wallet?.toLowerCase() !== wallet.toLowerCase())) {
      busy = false; connected();
      observationWarning('Reconnect the wallet used for this mint before checking its submission.');
      feedback('Your saved mint reference is kept. No new mint will be submitted automatically.');
      return false;
    }
    busy = false; connected();
    feedback('Checking your previous mint…');
    void poll(handle); return true;
  }
  function loadSession() {
    cancelOptionsRetry(); optionsFailed = false;
    connectionEpoch++; detachWalletEvents?.(); provider = undefined; wallet = undefined; sessionReady = false; connected();
    return api('/api/test/session').then(async s => {
      csrf = s.csrf; wallet = s.wallet; sessionReady = true;
      const pending = pendingReference(), priorReveal = sessionStorage.getItem('sg-sepolia-reveal');
      if (pending && $('[data-mint-entry]')) {
        pendingRecovery = true;
        resumeSavedMint(savedMintReference(pending));
        await restoreWallet(); connected(); return;
      }
      if (priorReveal && $('[data-mint-entry]')) {
        // Establish the same durable lock before parsing a reveal reference:
        // malformed storage must not bypass recovery via an explicit connect.
        pendingRecovery = true;
        // A validated reveal remains a public viewing fact; an expired wallet
        // proof must not prevent restoring its image. Clearing a no-submission
        // reference still requires authenticated proof inside poll().
        resumeSavedMint(savedMintReference(priorReveal), true);
        await restoreWallet(); connected(); return;
      }
      await restoreWallet(); connected();
    }).catch(e => { if (mintProcess) walletFeedback(e.message, true); connected(); });
  }
  let session = loadSession();
  window.addEventListener('sg:readiness-changed', event => {
    readReady = event.detail?.mintReady === true;
    presentSale(event.detail?.saleStatus, undefined, true);
    if (busy || connecting || restoring || revealed) return;
    connected();
    if (!event.detail?.mintReady) {
      const submit = $('[data-request-submit]'); if (submit) submit.disabled = true;
      return;
    }
    if (!sessionReady) { session = loadSession(); return; }
    if (wallet && provider && $('[data-pulse-options]')) {
      void options().then(connected).catch(() => {});
    }
  });
  window.addEventListener('pageshow', event => {
    // BFCache keeps the old document alive. Refresh its server proof and
    // wallet binding too, without initiating a sign-in or replaying a mint.
    if (!event.persisted) return;
    if (busy || revealed) {
      const saved = pendingReference() || sessionStorage.getItem('sg-sepolia-reveal');
      const handle = saved ? JSON.parse(saved).handle : detail?.dataset.revealHandle;
      if (/^[a-z0-9_]{1,15}$/.test(handle || '')) { statusGeneration++; void poll(handle); }
    } else if (!connecting && !restoring) session = loadSession();
  });
  const detail = $('[data-reveal-monitor]');
  if (detail?.dataset.revealHandle) {
    revealed = { state: detail.dataset.mintState, tokenId: detail.dataset.revealToken, inputDigest: detail.dataset.revealInput, rendererIdentity: detail.dataset.revealRenderer };
    void poll(detail.dataset.revealHandle);
  }
  window.addEventListener('pagehide', () => { statusGeneration++; clearTimeout(statusTimer); cancelOptionsRetry(); });
}
export const SEPOLIA_TEST_CLIENT = `(${sepoliaTestClient.toString()})(${mintHandleDraft.toString()}, ${bindHandleValidation.toString()}, ${renderInlineFeedback.toString()}, ${JSON.stringify(SEPOLIA_READ_BUDGETS)});`;
