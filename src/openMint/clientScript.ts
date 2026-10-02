import { mintUiState } from "./mintUiState.js";
import { createWalletProviders } from "./walletProviders.js";
import { canRevealMint } from "./revealPolicy.js";
import { REVEAL_MONITOR_SCRIPT } from "./revealMonitor.js";
import { mintHandleDraft } from "./mintHandleDraft.js";
import { bindHandleValidation } from "./fieldValidation.js";
import { renderInlineFeedback } from "./inlineFeedback.js";

/** Shared, bounded failure copy for the server-rendered page and live polling. */
export function assessmentFailureText(input: { error?: unknown; errorCategory?: unknown; diagnosticReference?: unknown }): string {
  let text = typeof input.error === "string" && input.error ? input.error.slice(0, 1000) : "The assessment could not be completed. No mint transaction was submitted.";
  if (input.errorCategory === "assessment-abstained") text = "Grok could not choose a signature from the available evidence. No mint was submitted. This result will not be retried automatically.";
  if (input.errorCategory === "assessment-blocked") text = "This assessment needs operator review before it can continue. No new assessment or mint will be requested automatically.";
  if (input.errorCategory === "preparation-interrupted") text = "Your assessment was saved, but artwork preparation needs operator review. No new assessment will be requested automatically.";
  const reference = input.diagnosticReference;
  if (typeof reference === "string" && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|legacy-[a-f0-9]{24})$/.test(reference)) text += ` Reference: ${reference}.`;
  return text;
}

/** Explicit wallet-gated mint intent; early reveal requires verified inclusion. */
export const OPEN_MINT_CLIENT_SCRIPT = REVEAL_MONITOR_SCRIPT + String.raw`(() => {
  const mintUiState = ${mintUiState.toString()};
  const canRevealMint = ${canRevealMint.toString()};
  const assessmentFailureText = ${assessmentFailureText.toString()};
  const createWalletProviders = ${createWalletProviders.toString()};
  const mintHandleDraft = ${mintHandleDraft.toString()};
  const bindHandleValidation = ${bindHandleValidation.toString()};
  const renderInlineFeedback = ${renderInlineFeedback.toString()};
  if (window.__openMintBound) return;
  window.__openMintBound = true;
  const one = (selector) => document.querySelector(selector);
  const all = (selector) => document.querySelectorAll(selector);
  const root = one('[data-open-mint]');
  if (!root || one('[data-reveal-monitor]')) return;
  const candidate = one('[data-assessment-code]');
  const page = /^[A-Za-z0-9_-]{43}$/.test(candidate?.dataset.assessmentCode || '') ? candidate : null;
  const code = page?.dataset.assessmentCode || '';
  const handle = page?.dataset.assessmentHandle || '';
  const tokenId = page?.dataset.tokenId || '';
  const local = root.dataset.localChain === 'true';
  const durableSubmission = root.dataset.durableWalletSubmission === 'true';
  const addressPattern = /^0x[0-9a-f]{40}$/i;
  const hashPattern = /^0x[0-9a-f]{64}$/i;
  const codePattern = /^[A-Za-z0-9_-]{43}$/;
  const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const walletAddress = (value) => typeof value === 'string' ? value : value?.wallet?.address || value?.wallet || value?.address;
  const message = (selector, text, warning = false) => { if (stopped) return; renderInlineFeedback(one(selector), text, warning); };
  const feedback = (text, warning = false) => message('[data-mint-feedback]', text, warning);
  const storageGet = (key) => { try { return JSON.parse(sessionStorage.getItem('sg-open:' + key) || 'null'); } catch { return null; } };
  const storageSet = (key, value) => { try { sessionStorage.setItem('sg-open:' + key, JSON.stringify(value)); } catch {} };
  const storageRemove = (key) => { try { sessionStorage.removeItem('sg-open:' + key); } catch {} };
  const intentKey = 'intent:' + code;
  const submissionKey = 'submission:' + code;
  let stopped = false, timer, bootTimer, expiryTimer, sessionPromise, verified = null, walletMode = 'injected';
  let walletBusy = false, mintBusy = false, requestBusy = false, walletGeneration = 0;
  let submittedHash = null, uncertainSubmission = false, reportNeeded = false;
  let submissionPermit = null;
  let submittedWallet = null, submittedAt = 0, expectedNonce = null;
  let inspectionGeneration = 0;
  let booting = true;
  let awaitingApproval = false, readUnavailable = false;
  let bootGeneration = 0, assessmentGeneration = 0, mintGeneration = 0;
  let assessmentBusy = false, mintPollBusy = false, readFailures = 0, bootFailures = 0;
  let bootFeedback = null;
  let requestDeadline = 0, proofDeadline = 0;
  let reservedUntil = 0;
  const wallets = createWalletProviders(window);
  let selectedWallet = null, cancelWalletChoice = null;
  const readTimeoutMs = 8000;
  const delayedConfirmationMs = 30000;
  const abort = new AbortController();
  const retryDelay = failures => Math.min(30000, 2500 * 2 ** Math.min(failures, 4));
  const requestExpired = () => Boolean(page && (page.dataset.requestExpired === 'true' || (requestDeadline > 0 && Date.now() >= requestDeadline)));
  const ui = () => mintUiState({ assessmentStatus: page?.dataset.assessmentState, mintState: durableSubmission && uncertainSubmission && !submittedHash ? 'unknown' : page?.dataset.mintState,
    requestExpired: requestExpired(), canMint: page?.dataset.canMint === 'true', walletVerified: Boolean(verified),
    submitted: Boolean(submittedHash), uncertain: uncertainSubmission, awaitingApproval, booting, walletBusy, mintBusy,
    hasIntent: Boolean(storageGet(intentKey)), readUnavailable });
  const asChain = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('The mint network is unavailable. Reload this page.');
    const chain = BigInt(value);
    if (chain <= 0n) throw new Error('The mint network is unavailable. Reload this page.');
    return '0x' + chain.toString(16);
  };
  const errorText = (error) => {
    if (error?.code === 'UNSUPPORTED_ACCOUNT') return 'Minting supports accounts without on-chain code only. Contract wallets and delegated or other code-bearing accounts are not supported. Choose a different account in your wallet and reconnect.';
    if (error?.code === 4200 || error?.code === -32601) return 'This wallet does not support the required signing or network method. Choose another injected wallet and reconnect.';
    if (error?.code === 4100) return 'Wallet access is not authorized. Unlock your selected wallet, allow account access, and reconnect.';
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Cancelled in your wallet. Your prepared signature is unchanged. Choose Continue mint when ready.';
    if (error?.code === 'MINT_RESERVED') {
      const expires = Date.parse(error.reservedUntil);
      return Number.isFinite(expires) && expires > Date.now()
        ? 'Another mint authorization is reserved until ' + new Date(expires).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') + '. After that, choose Continue mint to check availability.'
        : 'Another mint authorization is reserved. Wait for its window to end, then choose Continue mint to check availability.';
    }
    if (error?.code === 'ASSESSMENT_RETRY_BLOCKED' || error?.category === 'assessment') return assessmentFailureText({ errorCategory: 'assessment-blocked', diagnosticReference: error.reference });
    if (['REQUEST_EXPIRED', 'SESSION_EXPIRED', 'SESSION_REQUIRED', 'CSRF_INVALID', 'CSRF_FAILED', 'REQUEST_SESSION_MISMATCH', 'REQUEST_WALLET_MISMATCH'].includes(error?.code)) return 'This request or browser session is no longer available. Return to mint and reconnect your wallet. Any saved assessment and artwork will be reused.';
    if (['TOKEN_ALREADY_MINTED', 'HANDLE_ALREADY_MINTED', 'ALREADY_MINTED'].includes(error?.code)) return 'This handle already has a token or is confirming.';
    if (['TOKEN_BINDING_MISMATCH', 'WALLET_PROOF_REQUIRED', 'WALLET_MISMATCH', 'WALLET_CHANGED', 'REQUEST_NOT_OWNED', 'CHALLENGE_EXPIRED', 'CHALLENGE_REPLACED', 'INVALID_PROOF'].includes(error?.code)) return 'Connect and verify the wallet for this request again. Your saved assessment is unchanged.';
    if (error?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(error?.message || '')) return 'Your wallet needs enough native currency for network gas. Check its balance on the mint network, then choose Continue mint.';
    if (error?.code === 'WALLET_NETWORK_MISMATCH' || error?.code === 'MINT_NETWORK_UNAVAILABLE' || error?.category === 'network') return (error.message || 'The mint network is unavailable.') + ' Check the configured network/RPC in your wallet, then reconnect and continue.';
    if ([4900, 4901, 4902, 'NETWORK_ERROR'].includes(error?.code)) return 'Your wallet cannot reach the mint network. Restore the configured network/RPC, then reconnect and continue.';
    return typeof error?.message === 'string' ? error.message : 'The request could not be completed. Please try again.';
  };
  const updateButtons = () => {
    if (stopped) return;
    if (page) {
      const view = ui();
      if (view.clearIntent) storageRemove(intentKey);
      page.dataset.progressRecovery = String(view.canConnect || view.canSubmit);
      if (page.dataset.mintUiPhase !== view.phase) message('[data-assessment-status]', view.status);
      page.dataset.mintUiPhase = view.phase;
      const recovery = one('[data-request-recovery]'); if (recovery) recovery.hidden = !view.showReturn;
      const support = one('[data-assessment-support]'); if (support) support.hidden = view.phase !== 'failed' && view.phase !== 'abstained';
      message('[data-request-recovery-message]', view.phase === 'expired' ? 'Return to mint to continue. Any saved assessment and artwork will be reused.' : 'Return to mint in this browser to continue. Any saved assessment and artwork will be reused.');
      const form = one('[data-mint-form]'); if (form) form.hidden = !view.canSubmit;
      const retry = one('[data-check-progress]'); if (retry) { retry.hidden = !readUnavailable || view.showReturn; retry.disabled = booting || assessmentBusy || mintPollBusy; }
      if (view.canSubmit && reservedUntil > Date.now()) message('[data-assessment-status]', 'Mint temporarily reserved.');
      const knownHash = submittedHash || page.dataset.mintTransactionHash;
      const transaction = one('[data-mint-transaction]');
      if (transaction) { transaction.hidden = !hashPattern.test(knownHash || ''); if (!transaction.hidden) transaction.textContent = 'Transaction: ' + knownHash; }
    }
    all('[data-assessment-request]').forEach((form) => {
      const button = form.querySelector('button[type=submit]');
      if (button) button.disabled = booting || !verified || walletBusy || mintBusy || requestBusy;
    });
    const blocked = !page || !ui().canSubmit || reservedUntil > Date.now();
    const mint = one('[data-submit-mint]');
    if (mint) mint.disabled = Boolean(blocked || walletMode !== 'injected');
    const dev = one('[data-dev-mint]');
    if (dev) dev.disabled = Boolean(blocked || walletMode !== 'local');
  };
  const invalidateWallet = () => { walletGeneration++; verified = null; proofDeadline = 0; storageRemove(intentKey); storageRemove('wallet-mode'); updateButtons(); };
  const recoverError = error => {
    if (stopped) return;
    if (['WALLET_PROOF_REQUIRED', 'CHALLENGE_EXPIRED', 'CHALLENGE_REPLACED', 'INVALID_PROOF'].includes(error?.code)) invalidateWallet();
    if (['SESSION_EXPIRED', 'SESSION_REQUIRED', 'CSRF_INVALID', 'CSRF_FAILED', 'REQUEST_SESSION_MISMATCH', 'REQUEST_WALLET_MISMATCH'].includes(error?.code)) {
      sessionPromise = null; invalidateWallet();
      if (page) { page.dataset.requestExpired = 'true'; page.dataset.canMint = 'false'; }
    }
    if (error?.code === 'REQUEST_EXPIRED' && page) { page.dataset.requestExpired = 'true'; page.dataset.canMint = 'false'; storageRemove(intentKey); }
    if (error?.code === 'MINT_RESERVED') {
      storageRemove(intentKey);
      const expires = Date.parse(error.reservedUntil);
      reservedUntil = Number.isFinite(expires) && expires > Date.now() ? expires : 0;
      checkExpiry();
    }
    updateButtons();
  };
  const readJson = async (path, options = {}) => {
    const readOnly = !options.method || options.method === 'GET';
    const controller = readOnly ? new AbortController() : abort;
    let timeout, cancel;
    const operation = async () => {
      const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || 'The request was rejected.');
        error.code = payload?.error?.code || payload?.code;
        error.url = payload?.url;
        if (typeof payload?.reference === 'string' && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|legacy-[a-f0-9]{24})$/.test(payload.reference)) error.reference = payload.reference;
        if (typeof payload?.reservedUntil === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(payload.reservedUntil) && Number.isFinite(Date.parse(payload.reservedUntil))) error.reservedUntil = payload.reservedUntil;
        if (['reservation', 'assessment', 'wallet', 'network', 'temporary'].includes(payload?.category)) error.category = payload.category;
        throw error;
      }
      return payload;
    };
    if (stopped) throw new Error('This page is no longer active.');
    if (!readOnly) return operation();
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error('This page is no longer active.')); };
        abort.signal.addEventListener('abort', cancel, { once: true });
        if (abort.signal.aborted) cancel();
        timeout = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Progress checking timed out. This page will retry.'), { code: 'READ_TIMEOUT' })); }, readTimeoutMs);
      })]);
    } finally { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); }
  };
  const session = async () => {
    if (!sessionPromise) sessionPromise = readJson('/api/session', { cache: 'no-store' }).then(state => {
      if (!state.csrfToken || typeof state.csrfToken !== 'string') throw new Error('Your browser session is unavailable. Reload this page.');
      return state;
    }).catch((error) => { sessionPromise = null; throw error; });
    const state = await sessionPromise;
    if (stopped) throw new Error('This page is no longer active.');
    return state;
  };
  const post = async (path, body, beforeSend) => {
    const state = await session();
    beforeSend?.();
    return readJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify(body) });
  };
  const expectedChain = (state) => {
    const chain = asChain(state.chainId);
    if (root.dataset.chainId && asChain(root.dataset.chainId) !== chain) throw new Error('The mint network changed. Reload before continuing.');
    return chain;
  };
  const provider = () => {
    if (!selectedWallet) throw new Error('Choose and connect an injected wallet before continuing.');
    return selectedWallet.provider;
  };
  const bindWallet = choice => {
    if (selectedWallet?.provider === choice?.provider) return;
    selectedWallet?.provider.removeListener?.('accountsChanged', onAccounts);
    selectedWallet?.provider.removeListener?.('chainChanged', onChain);
    selectedWallet?.provider.removeListener?.('disconnect', onDisconnect);
    selectedWallet = choice;
    selectedWallet?.provider.on?.('accountsChanged', onAccounts);
    selectedWallet?.provider.on?.('chainChanged', onChain);
    selectedWallet?.provider.on?.('disconnect', onDisconnect);
  };
  const chooseWallet = async button => {
    const choices = wallets.choices();
    if (!choices.length) throw new Error('No Ethereum wallet was found. Open this page in a browser with an injected wallet.');
    if (choices.length === 1) return choices[0];
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Choose a wallet');
      dialog.dataset.walletChoice = 'true';
      const title = document.createElement('p'); title.textContent = 'Choose a wallet'; dialog.append(title);
      const finish = choice => { cancelWalletChoice = null; dialog.close(); dialog.remove(); if (!stopped) button.focus(); resolve(choice); };
      choices.forEach((choice, index) => {
        const option = document.createElement('button'); option.type = 'button';
        option.textContent = choice.name + (choice.rdns ? ' (' + choice.rdns + ')' : '') + ' · ' + (index + 1);
        option.addEventListener('click', () => finish(choice)); dialog.append(option);
      });
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(null)); dialog.append(cancel);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      cancelWalletChoice = () => finish(null);
      document.body.append(dialog); dialog.showModal();
    });
  };
  const supportedAccount = async (ethereum, address) => {
    const code = await ethereum.request({ method: 'eth_getCode', params: [address, 'latest'] });
    if (typeof code !== 'string' || !/^0x(?:[a-f0-9]{2})*$/i.test(code)) throw new Error('The wallet account type could not be checked. Reconnect and try again.');
    if (code !== '0x') throw Object.assign(new Error('Unsupported account'), { code: 'UNSUPPORTED_ACCOUNT' });
  };
  const isQuantity = (value) => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  const quantity = (value) => {
    if (!isQuantity(value)) throw new Error('The wallet network proof or transaction nonce is invalid. Nothing was sent. Reload before continuing.');
    return value;
  };
  const validateNetwork = (context, state) => {
    if (!context || quantity(context.chainId) !== expectedChain(state) || !addressPattern.test(context.contract || '') || !sameAddress(context.contract, root.dataset.contract) || !hashPattern.test(context.blockHash || '')) throw new Error('The mint network proof does not match this page. Nothing was sent. Reload before continuing.');
    quantity(context.blockNumber);
    return context;
  };
  const configuredLocalRpc = state => {
    if (!local || expectedChain(state) !== '0x7a69' || typeof state.rpcUrl !== 'string') return null;
    try {
      const rpc = new URL(state.rpcUrl);
      return ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) && ['http:', 'https:'].includes(rpc.protocol) && !rpc.username && !rpc.password && !rpc.search && !rpc.hash ? rpc.href : null;
    } catch { return null; }
  };
  const verifyNetwork = async (ethereum, state, context) => {
    const generation = walletGeneration;
    const networkLabel = one('[data-mint-network]'); if (networkLabel && !stopped) networkLabel.hidden = true;
    validateNetwork(context, state);
    const rpc = configuredLocalRpc(state);
    const proofRead = async request => {
      try { return await ethereum.request(request); }
      catch (error) {
        if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') throw error;
        if (generation !== walletGeneration) throw Object.assign(new Error('Your wallet changed during the network check. Reconnect before continuing.'), { code: 'MINT_NETWORK_UNAVAILABLE' });
        throw Object.assign(new Error('Cannot verify your wallet RPC.' + (rpc ? ' Configured local RPC: ' + rpc + '.' : '')), { code: 'MINT_NETWORK_UNAVAILABLE' });
      }
    };
    const block = await proofRead({ method: 'eth_getBlockByNumber', params: [context.blockNumber, false] });
    if (!block || block.number !== context.blockNumber || !sameAddress(block.hash, context.blockHash) || asChain(await proofRead({ method: 'eth_chainId' })) !== expectedChain(state)) throw Object.assign(new Error(rpc ? 'Your wallet is connected to a different local chain. Set its RPC to ' + rpc + ', then reconnect.' : 'Your wallet is connected to a different chain. Check its RPC and reconnect.'), { code: 'WALLET_NETWORK_MISMATCH' });
    if (generation !== walletGeneration) throw Object.assign(new Error('Your wallet changed during the network check. Reconnect before continuing.'), { code: 'MINT_NETWORK_UNAVAILABLE' });
    if (networkLabel && !stopped) { networkLabel.textContent = 'Verified mint network: chain ' + BigInt(expectedChain(state)).toString() + '.'; networkLabel.hidden = false; }
  };
  const walletUnchanged = async (ethereum, state, address, generation, requireVerified = true) => {
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    const chain = await ethereum.request({ method: 'eth_chainId' });
    if (stopped || ethereum !== selectedWallet?.provider || generation !== walletGeneration || !sameAddress(accounts?.[0], address) || asChain(chain) !== expectedChain(state) || (requireVerified && !sameAddress(verified, address))) throw new Error('The wallet changed during preparation. Connect it again.');
  };
  const ensureChain = async (ethereum, state) => {
    const chainId = expectedChain(state);
    if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== chainId) {
      try { await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        if (Number(error?.code) !== 4902 || !local || !state.rpcUrl) throw error;
        const rpc = new URL(state.rpcUrl);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) || !['http:', 'https:'].includes(rpc.protocol)) throw new Error('The local chain RPC must use a loopback address.');
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: state.chainName || 'Local test chain', rpcUrls: [rpc.href], nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 } }] });
        await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
    }
    if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== chainId) throw new Error('Switch your wallet to the mint network and try again.');
    const context = await readJson('/api/wallet/context', { cache: 'no-store' });
    await verifyNetwork(ethereum, state, context);
    return context;
  };
  const assertContext = () => {
    if (requestExpired()) throw Object.assign(new Error('This mint request has expired. Return to mint; any saved assessment will be reused.'), { code: 'REQUEST_EXPIRED' });
    if (!page || !codePattern.test(code) || page.dataset.assessmentCode !== code || page.dataset.assessmentHandle !== handle || page.dataset.tokenId !== tokenId || page.dataset.assessmentState !== 'ready' || page.dataset.canMint !== 'true') throw new Error('This request is not ready to mint in this browser session.');
  };
  const walletReady = (address, state, mode) => {
    if (!addressPattern.test(address || '')) throw new Error('The wallet verification response was invalid.');
    verified = address; walletMode = mode;
    storageSet('wallet-mode', { address, mode });
    if (mode === 'injected') storageSet('wallet-provider', selectedWallet?.key);
    message('[data-wallet-label]', address);
    all('[data-connect-wallet]').forEach(button => { (button.querySelector('span') || button).textContent = 'Change wallet'; });
    updateButtons();
  };
  const reveal = (state) => {
    if (stopped) return;
    stopped = true; abort.abort(); bootGeneration++; assessmentGeneration++; mintGeneration++; inspectionGeneration++;
    clearTimeout(timer); clearTimeout(bootTimer); clearTimeout(expiryTimer);
    storageRemove(intentKey);
    // A provisional reveal must not erase the guard on the private mint request.
    if (state === 'minted') storageRemove(submissionKey);
    if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) location.assign('/signatures/' + encodeURIComponent(handle));
  };
  const schedule = (callback, delay = 2500) => { clearTimeout(timer); if (!stopped) timer = setTimeout(callback, delay); };
  const checkExpiry = () => {
    if (stopped) return;
    clearTimeout(expiryTimer);
    if (requestExpired()) {
      page.dataset.requestExpired = 'true'; page.dataset.canMint = 'false';
      storageRemove(intentKey); assessmentGeneration++;
    }
    if (proofDeadline > 0 && Date.now() >= proofDeadline) invalidateWallet();
    if (reservedUntil > 0 && Date.now() >= reservedUntil) {
      reservedUntil = 0;
      if (!submittedHash && !uncertainSubmission && !requestExpired() && page?.dataset.mintState === 'unminted') {
        message('[data-assessment-status]', ui().status);
        feedback('The reservation window ended. Choose Continue mint to check availability.');
      }
    }
    const intent = storageGet(intentKey);
    if (intent && (!Number.isFinite(intent.expiresAt) || intent.expiresAt <= Date.now())) storageRemove(intentKey);
    updateButtons();
    const deadlines = [requestExpired() ? 0 : requestDeadline, proofDeadline, reservedUntil, storageGet(intentKey)?.expiresAt].filter(value => Number.isFinite(value) && value > Date.now());
    if (deadlines.length) expiryTimer = setTimeout(checkExpiry, Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
  };
  const syncDeadlines = state => {
    const clock = Number(state.serverNow);
    if (Number.isSafeInteger(clock) && clock > 0) {
      const expires = Number(state.requestExpiresAt);
      if (Number.isSafeInteger(expires) && expires > 0) {
        const deadline = Date.now() + Math.max(0, expires - clock);
        requestDeadline = requestDeadline ? Math.min(requestDeadline, deadline) : deadline;
      }
      const proof = Number(state.walletProofExpiresAt);
      if (Number.isSafeInteger(proof) && proof > 0) {
        const deadline = Date.now() + Math.max(0, proof - clock);
        proofDeadline = proofDeadline ? Math.min(proofDeadline, deadline) : deadline;
      }
    }
    if (state.requestExpired === true || state.requestExpired === 'true') page.dataset.requestExpired = 'true';
    checkExpiry();
  };
  const boundedCheck = (promise) => {
    let timeout, cancel;
    return Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(new Error('This page is no longer active.'));
      abort.signal.addEventListener('abort', cancel, { once: true });
      if (abort.signal.aborted) cancel();
      timeout = setTimeout(() => reject(new Error('Confirmation check timed out.')), readTimeoutMs);
    })]).finally(() => { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); });
  };
  const pendingFeedback = (text, status = 'Mint submitted. Waiting to reveal your signature…', warning = false) => {
    feedback(text, warning); message('[data-assessment-status]', status);
    message('[data-poll-feedback]', durableSubmission && one('[data-mint-transaction]') ? '' : 'Transaction: ' + submittedHash);
  };
  const inspectSubmissionRead = async (mintState, inspection) => {
    if (!submittedHash || walletMode !== 'injected' || stopped) return false;
    const hash = submittedHash, generation = walletGeneration;
    try {
      const ethereum = provider(), state = await session();
      if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== expectedChain(state)) throw Object.assign(new Error('Wrong wallet network'), { code: 'WALLET_NETWORK_MISMATCH' });
      const context = await readJson('/api/wallet/context', { cache: 'no-store' });
      await verifyNetwork(ethereum, state, context);
      if (!addressPattern.test(submittedWallet || '')) throw new Error('The original transaction wallet is unavailable.');
      const [tx, latest, pending, receipt] = await Promise.all([
        ethereum.request({ method: 'eth_getTransactionByHash', params: [hash] }),
        ethereum.request({ method: 'eth_getTransactionCount', params: [submittedWallet, 'latest'] }),
        ethereum.request({ method: 'eth_getTransactionCount', params: [submittedWallet, 'pending'] }),
        mintState === 'unminted' ? ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] }) : Promise.resolve(null),
      ]);
      // A wallet may change RPC during these reads, even without a chainChanged event.
      await verifyNetwork(ethereum, state, context);
      if (stopped || submittedHash !== hash || generation !== walletGeneration || inspection !== inspectionGeneration) return false;
      if (!isQuantity(latest) || !isQuantity(pending) || BigInt(pending) < BigInt(latest)) throw new Error('Invalid transaction counts');
      const delayed = Date.now() - submittedAt >= delayedConfirmationMs;
      if (tx === null) {
        pendingFeedback(delayed ? 'The transaction is not currently visible on the verified mint network. It may still be propagating or may have been dropped. Check wallet activity; do not submit another mint until this transaction is resolved.' : 'Transaction submitted. Waiting for it to appear on the mint network.', delayed ? 'Transaction not found. Check wallet activity.' : undefined, delayed);
        return false;
      }
      if (!tx || !sameAddress(tx.hash, hash) || !sameAddress(tx.from, submittedWallet) || !sameAddress(tx.to, root.dataset.contract) || !isQuantity(tx.nonce) || !(tx.blockNumber === null || isQuantity(tx.blockNumber)) || (tx.chainId !== undefined && (!isQuantity(tx.chainId) || tx.chainId !== expectedChain(state)))) {
        pendingFeedback('The wallet returned transaction details that do not match this mint. Check wallet activity; do not submit another mint until this transaction is resolved.', 'Transaction details could not be verified.', true);
        return false;
      }
      if (mintState === 'unminted' && receipt?.status === '0x0' && sameAddress(receipt.transactionHash, hash) && sameAddress(receipt.from, submittedWallet) && sameAddress(receipt.to, root.dataset.contract) && isQuantity(receipt.blockNumber) && tx.blockNumber === receipt.blockNumber && hashPattern.test(receipt.blockHash || '')) {
        const receiptBlock = await ethereum.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
        await verifyNetwork(ethereum, state, context);
        if (stopped || submittedHash !== hash || generation !== walletGeneration || inspection !== inspectionGeneration) return false;
        if (receiptBlock?.number !== receipt.blockNumber || !sameAddress(receiptBlock.hash, receipt.blockHash)) throw new Error('The reverted receipt is not on the verified chain.');
        submittedHash = null; uncertainSubmission = false; expectedNonce = null; storageRemove(submissionKey);
        page.dataset.mintState = 'unminted';
        message('[data-poll-feedback]', '');
        message('[data-assessment-status]', 'The mint transaction reverted. Your signature is ready to mint.');
        feedback(requestExpired() ? 'The transaction reverted. Return to mint; your saved assessment and artwork will be reused.' : 'The transaction reverted. Your prepared signature is unchanged. You can Continue mint.', true);
        updateButtons(); return true;
      }
      if (tx.blockNumber === null && BigInt(tx.nonce) > BigInt(pending)) {
        pendingFeedback('Transaction nonce ' + BigInt(tx.nonce) + '; chain expects ' + BigInt(pending) + '. This transaction is queued behind a nonce gap. Correct the ' + (local ? 'local ' : '') + 'wallet nonce, and do not submit another mint until this transaction is resolved.', 'Mint waiting for a wallet nonce gap to be resolved.', true);
      } else if (expectedNonce !== null && tx.nonce !== expectedNonce) {
        pendingFeedback('Your wallet broadcast transaction nonce ' + BigInt(tx.nonce) + '; the mint requested ' + BigInt(expectedNonce) + '. Check wallet activity; do not submit another mint until this transaction is resolved.', 'The wallet changed the mint transaction nonce.', true);
      } else if (tx.blockNumber !== null) {
        pendingFeedback('The transaction was mined. Waiting for the server to verify the mint before revealing your signature.');
      } else {
        pendingFeedback(delayed ? 'The transaction is still pending on the mint network. Confirmation is taking longer than expected. Check wallet activity; do not submit another mint until this transaction is resolved.' : 'Transaction submitted. Waiting for confirmation to reveal your signature.', delayed ? 'Mint confirmation is taking longer than expected.' : undefined, delayed);
      }
    } catch (error) {
      if (stopped || submittedHash !== hash || inspection !== inspectionGeneration) return false;
      if (error?.code === 'WALLET_NETWORK_MISMATCH') {
        pendingFeedback('Transaction checking is paused because your wallet is on a different mint network. Restore the correct wallet RPC/network; do not submit another mint while this transaction is unresolved.', 'Switch back to the mint network to check this transaction.', true);
      } else if (error?.code === 'MINT_NETWORK_UNAVAILABLE') {
        pendingFeedback(errorText(error) + ' Do not submit another mint while this transaction is unresolved.', 'Cannot verify the wallet RPC. Transaction checking will retry.', true);
      } else {
        message('[data-poll-feedback]', 'Transaction checking is temporarily unavailable. This page will retry. Do not submit another mint. Transaction: ' + hash, true);
      }
    }
    return false;
  };
  const inspectSubmission = async (mintState) => {
    if (!submittedHash || walletMode !== 'injected' || stopped) return false;
    const inspection = ++inspectionGeneration;
    try { return await boundedCheck(inspectSubmissionRead(mintState, inspection)); }
    catch {
      if (!stopped && inspection === inspectionGeneration) {
        inspectionGeneration++;
        message('[data-poll-feedback]', 'Transaction checking is temporarily unavailable. This page will retry. Do not submit another mint. Transaction: ' + submittedHash, true);
      }
      return false;
    }
  };
  const pollMint = async () => {
    if (stopped || !code || mintPollBusy) return;
    mintPollBusy = true;
    const generation = ++mintGeneration;
    let result;
    try {
      try {
        result = await readJson('/api/mints/status/' + encodeURIComponent(code), { cache: 'no-store' });
        if (stopped || generation !== mintGeneration) return;
        readUnavailable = false;
        if (hashPattern.test(result?.transactionHash || '')) page.dataset.mintTransactionHash = result.transactionHash;
      } catch (error) {
        if (!stopped && generation === mintGeneration) { recoverError(error); readUnavailable = true; updateButtons(); message('[data-poll-feedback]', 'Confirmation is temporarily unavailable. This page will retry.' + (submittedHash ? ' Transaction: ' + submittedHash : '') + (['SESSION_REQUIRED', 'SESSION_EXPIRED', 'REQUEST_SESSION_MISMATCH', 'REQUEST_WALLET_MISMATCH'].includes(error?.code) ? ' Restore the original browser session and wallet. Do not submit another mint.' : ''), true); }
      }
      if (stopped || generation !== mintGeneration) return;
      if (canRevealMint(result?.state)) { reveal(result.state); return; }
      if (durableSubmission && result?.state === 'pending') {
        page.dataset.mintState = 'pending'; storageRemove(intentKey);
        if (!submittedHash && hashPattern.test(result.transactionHash || '')) setPending(result.transactionHash, submittedWallet || verified);
        uncertainSubmission = !submittedHash;
        if (uncertainSubmission) feedback('A wallet submission was started, but its outcome is unknown. Check wallet activity. No new transaction will be sent automatically.', true);
      }
      if (submittedHash && reportNeeded) {
        try { await boundedCheck(post('/api/mints/report', { code, transactionHash: submittedHash, ...(durableSubmission ? { permit: submissionPermit } : {}) })); reportNeeded = false; } catch {}
      }
      if (stopped || generation !== mintGeneration) return;
      if (await inspectSubmission(result?.state)) return;
      if (!stopped && generation === mintGeneration && (!result || result.state === 'pending' || submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending')) schedule(pollMint, result ? 2500 : 8000);
    } finally { mintPollBusy = false; updateButtons(); }
  };
  const setPending = (hash, wallet, nonce = null) => {
    submittedHash = hash; uncertainSubmission = false;
    submittedWallet = wallet; submittedAt = Date.now(); expectedNonce = nonce;
    storageSet(submissionKey, { hash, wallet, mode: walletMode, submittedAt, expectedNonce, ...(durableSubmission ? { permit: submissionPermit } : {}) });
    if (page) page.dataset.mintState = 'pending';
    message('[data-assessment-status]', 'Mint submitted. Waiting to reveal your signature…');
    feedback('Transaction submitted. Waiting for confirmation to reveal your signature.'); updateButtons();
  };
  const expiryTime = (value) => {
    if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return expiryTime(Number(value));
    return Date.parse(value);
  };
  const validateAuthorization = (result, state, recipient) => {
    assertContext();
    const tx = result.transaction;
    const savedCap = page.dataset.pulseMaxPriceWei;
    const pulse = savedCap !== undefined;
    if (pulse ? !/^(0|[1-9][0-9]*)$/.test(savedCap) || BigInt(savedCap) >= (1n << 256n) || result.version !== 'sg-pulse-wallet-plan-v1-rc1' : result.version === 'sg-pulse-wallet-plan-v1-rc1') throw new Error('The mint payment does not match your saved consent. Nothing was sent.');
    const expectedValue = pulse ? '0x' + BigInt(savedCap).toString(16) : '0x0';
    const expires = expiryTime(result.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('This mint authorization has expired. Continue mint for a fresh authorization.');
    if (result.code !== code || result.handle !== handle || String(result.tokenId) !== tokenId) throw new Error('The mint authorization is for a different work. Nothing was sent.');
    if (!tx || !sameAddress(tx.from, recipient) || !addressPattern.test(tx.to || '') || !addressPattern.test(root.dataset.contract || '') || !sameAddress(tx.to, root.dataset.contract) || asChain(tx.chainId) !== expectedChain(state) || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data || '') || !/^0x[0-9a-f]+$/i.test(tx.value || '') || (pulse ? tx.value !== expectedValue : BigInt(tx.value) !== 0n)) throw new Error('The mint transaction does not match the wallet, network, and work. Nothing was sent.');
    const network = validateNetwork(result.network, state);
    if (quantity(tx.nonce) !== quantity(network.nonce)) throw new Error('The mint transaction nonce does not match its network proof. Nothing was sent. Continue mint for a fresh authorization.');
    return { from: recipient, to: tx.to, data: tx.data, value: expectedValue, chainId: expectedChain(state), nonce: tx.nonce };
  };
  const submitMint = async (mode) => {
    if (stopped || mintBusy || submittedHash || uncertainSubmission || !verified || walletMode !== mode || requestExpired() || readUnavailable || reservedUntil > Date.now()) { updateButtons(); return; }
    mintBusy = true; storageRemove(intentKey); updateButtons();
    const recipient = verified, generation = walletGeneration;
    let sending = false, walletInvoked = false;
    try {
      assertContext();
      const state = await session();
      if (mode === 'local') {
        if (!local || expectedChain(state) !== '0x7a69') throw new Error('Local test minting is available only on chain 31337.');
        assertContext();
        sending = true; storageSet(submissionKey, { uncertain: true, wallet: recipient, mode });
        const result = await post('/api/dev/mint', { code, consent: true });
        if (canRevealMint(result.state)) { reveal(result.state); return; }
        if (!hashPattern.test(result.transactionHash || '')) throw new Error('The local wallet returned no valid transaction hash.');
        setPending(result.transactionHash, recipient);
      } else {
        const ethereum = provider(); await ensureChain(ethereum, state);
        await walletUnchanged(ethereum, state, recipient, generation);
        await supportedAccount(ethereum, recipient);
        feedback('Preparing your mint authorization…');
        const result = await post('/api/mints/authorize', { code, consent: true }, () => {
          assertContext();
          if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient)) throw new Error('The wallet changed. Connect it again.');
        });
        const transaction = validateAuthorization(result, state, recipient);
        await verifyNetwork(ethereum, state, result.network);
        const fresh = await readJson('/api/wallet/context?address=' + encodeURIComponent(recipient), { cache: 'no-store' });
        await verifyNetwork(ethereum, state, fresh);
        const providerNonce = quantity(await ethereum.request({ method: 'eth_getTransactionCount', params: [recipient, 'pending'] }));
        if (quantity(fresh.nonce) !== transaction.nonce || providerNonce !== transaction.nonce) throw new Error('The wallet transaction nonce changed or does not match this chain. Nothing was sent. Check pending wallet activity, then choose Continue mint.');
        // Simulate the exact transaction on the wallet's RPC, never broadcast a probe.
        await ethereum.request({ method: 'eth_call', params: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: transaction.value }, 'latest'] });
        // Another tab may consume the nonce while simulation is in flight.
        const finalContext = await readJson('/api/wallet/context?address=' + encodeURIComponent(recipient), { cache: 'no-store' });
        await verifyNetwork(ethereum, state, finalContext);
        await walletUnchanged(ethereum, state, recipient, generation);
        const finalNonce = quantity(await ethereum.request({ method: 'eth_getTransactionCount', params: [recipient, 'pending'] }));
        if (quantity(finalContext.nonce) !== transaction.nonce || finalNonce !== transaction.nonce) throw new Error('The wallet transaction nonce changed or does not match this chain. Nothing was sent. Check pending wallet activity, then choose Continue mint.');
        if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient)) throw new Error('The wallet changed during preparation. Connect it again.');
        validateAuthorization(result, state, recipient);
        awaitingApproval = true; updateButtons();
        feedback('Confirm the mint transaction in your wallet.' + (local ? ' Transaction nonce: ' + BigInt(transaction.nonce) + '.' : ''));
        sending = true; storageSet(submissionKey, { uncertain: true, wallet: recipient, mode });
        if (durableSubmission) {
          // A lost begin response is also uncertain: the server may have committed.
          const begun = await post('/api/mints/begin', { code, consent: true });
          if (!codePattern.test(begun?.permit || '') || !begun.transaction || ['from', 'to', 'data', 'value', 'chainId', 'nonce'].some(k => String(begun.transaction[k]).toLowerCase() !== String(transaction[k]).toLowerCase())) throw new Error('The saved submission does not match this transaction. Nothing was sent by this page; check progress before any retry.');
          submissionPermit = begun.permit;
          storageSet(submissionKey, { uncertain: true, wallet: recipient, mode, permit: submissionPermit });
          await walletUnchanged(ethereum, state, recipient, generation);
          if (stopped || generation !== walletGeneration) throw new Error('The wallet changed. Check progress before continuing.');
        }
        walletInvoked = true;
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [transaction] });
        if (!hashPattern.test(hash || '')) throw new Error('The wallet returned an invalid transaction hash.');
        setPending(hash, recipient, transaction.nonce);
        try { await boundedCheck(post('/api/mints/report', { code, transactionHash: hash, ...(durableSubmission ? { permit: submissionPermit } : {}) })); }
        catch { reportNeeded = true; feedback('Transaction submitted. Saving its status will retry. Transaction: ' + hash, true); }
        await inspectSubmission();
      }
      schedule(pollMint);
    } catch (error) {
      recoverError(error);
      let safeRejection = !durableSubmission;
      if (durableSubmission && walletInvoked && submissionPermit && (error?.code === 4001 || error?.code === 'ACTION_REJECTED')) {
        try { await boundedCheck(post('/api/mints/reject', { code, permit: submissionPermit })); safeRejection = true; submissionPermit = null; } catch {}
      }
      const localRejectedBeforeSend = mode === 'local' && ['REQUEST_EXPIRED', 'WALLET_PROOF_REQUIRED', 'NOT_READY', 'CONSENT_REQUIRED', 'CSRF_INVALID', 'CSRF_FAILED', 'SESSION_REQUIRED', 'SESSION_EXPIRED', 'REQUEST_SESSION_MISMATCH', 'MINT_RESERVED', 'CHAIN_CLOCK', 'MINT_UNAVAILABLE', 'MINT_NETWORK_UNAVAILABLE'].includes(error?.code);
      if (sending && !submittedHash && (!(error?.code === 4001 || error?.code === 'ACTION_REJECTED') || !safeRejection) && !localRejectedBeforeSend) {
        uncertainSubmission = true;
        feedback(durableSubmission && !walletInvoked
          ? 'The mint submission could not be verified. This page has not sent a wallet transaction. Check progress before any retry.'
          : 'The wallet response is uncertain. Check wallet activity before any retry. This page will check for a confirmed mint.', true); schedule(pollMint);
      } else if (durableSubmission && error?.code === 'SUBMISSION_UNRESOLVED') {
        uncertainSubmission = true; page.dataset.mintState = 'pending'; storageRemove(intentKey); feedback(errorText(error), true); schedule(pollMint, 100);
      } else {
        if (!submittedHash) storageRemove(submissionKey);
        feedback(errorText(error), error?.code !== 4001 && error?.code !== 'ACTION_REJECTED');
        if (['ALREADY_MINTED', 'HANDLE_ALREADY_MINTED', 'TOKEN_ALREADY_MINTED'].includes(error?.code)) {
          page.dataset.mintState = 'pending'; schedule(pollMint, 100);
        }
      }
    } finally { awaitingApproval = false; mintBusy = false; updateButtons(); }
  };
  const resumeIntent = async () => {
    const intent = storageGet(intentKey);
    if (!intent || stopped || requestExpired() || readUnavailable || page?.dataset.assessmentState !== 'ready') { if (requestExpired()) storageRemove(intentKey); return; }
    storageRemove(intentKey);
    const state = await session();
    if (intent.code !== code || intent.handle !== handle || String(intent.tokenId) !== tokenId || !sameAddress(intent.wallet, verified) || intent.mode !== walletMode || intent.chain !== expectedChain(state) || !sameAddress(intent.contract, root.dataset.contract) || !Number.isFinite(intent.expiresAt) || intent.expiresAt <= Date.now()) { feedback('Choose Continue mint when you are ready.'); return; }
    await submitMint(intent.mode);
  };
  const pollAssessment = async () => {
    if (stopped || !code || assessmentBusy || requestExpired()) { updateButtons(); return; }
    assessmentBusy = true;
    const generation = ++assessmentGeneration, wallet = walletGeneration;
    try {
      const result = await readJson('/api/assessments/' + encodeURIComponent(code), { cache: 'no-store' });
      if (stopped || generation !== assessmentGeneration) return;
      const state = result.assessment || result;
      if (state.handle !== handle || String(state.tokenId) !== tokenId) throw new Error('The prepared request does not match this handle.');
      readUnavailable = false; readFailures = 0; message('[data-poll-feedback]', '');
      syncDeadlines(state);
      if (canRevealMint(state.mint?.state)) { reveal(state.mint.state); return; }
      if (state.mint?.state === 'pending') {
        storageRemove(intentKey); page.dataset.mintState = 'pending';
        if (hashPattern.test(state.mint.transactionHash || '')) page.dataset.mintTransactionHash = state.mint.transactionHash;
        message('[data-assessment-status]', 'Mint submitted. Waiting to reveal your signature…');
        updateButtons(); schedule(pollMint); return;
      }
      if (requestExpired()) { updateButtons(); return; }
      if (state.status === 'failed' || state.status === 'abstained') { storageRemove(intentKey); page.dataset.assessmentState = state.status; feedback(assessmentFailureText(state), true); updateButtons(); return; }
      if (state.status === 'ready') {
        page.dataset.assessmentState = 'ready'; page.dataset.canMint = String(state.canMint === true); page.dataset.walletProved = String(state.walletProvedForCode === true);
        if (state.walletProvedForCode !== true || wallet !== walletGeneration) invalidateWallet();
        const form = one('[data-mint-form]'); if (form) form.hidden = false;
        feedback(''); updateButtons(); await resumeIntent(); updateButtons(); return;
      }
      schedule(pollAssessment);
    } catch (error) {
      if (!stopped && generation === assessmentGeneration) {
        recoverError(error);
        if (requestExpired()) { message('[data-poll-feedback]', errorText(error), true); return; }
        readUnavailable = true; storageRemove(intentKey); updateButtons();
        message('[data-poll-feedback]', errorText(error) + ' Checking again automatically; you can also choose Check progress.', true);
        schedule(pollAssessment, retryDelay(++readFailures));
      }
    } finally { assessmentBusy = false; updateButtons(); }
  };
  all('[data-assessment-request]').forEach((form) => {
    bindHandleValidation(form);
    const input = form.querySelector('input[name=handle]');
    const saveHandleDraft = mintHandleDraft(input);
    const link = form.querySelector('[data-mint-preview]');
    const updatePreview = () => {
      saveHandleDraft();
      if (!link) return;
      const handle = (input?.value || '').trim().replace(/^@/, '');
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) link.setAttribute('href', '/p/' + encodeURIComponent(handle) + '/variations');
      else link.removeAttribute('href');
    };
    input?.addEventListener('input', updatePreview);
    updatePreview();
    if(form.dataset.pulseMint === 'true') {
      const clear = () => { delete form.dataset.pulseQuote; form.querySelectorAll('input[name=pulse-mode]').forEach(r => {r.checked=false;r.disabled=true;}); const cap=form.querySelector('input[name=pulse-max-eth]'); if(cap) cap.disabled=true; };
      input?.addEventListener('input',clear);
      form.querySelector('[data-pulse-check]')?.addEventListener('click',async () => {
        clear();
        const handle=(input?.value || '').trim().replace(/^@/,'');
        const generation=walletGeneration;
        if(!verified || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) { message('[data-pulse-feedback]','Enter a handle and connect your wallet first.', true); return; }
        try {
          const q=await readJson('/api/mints/options?handle='+encodeURIComponent(handle));
          if(generation !== walletGeneration || (input?.value || '').trim().replace(/^@/,'') !== handle || q.version !== 'sg-pulse-mint-options-v1' || q.handle !== handle.toLowerCase() || !sameAddress(q.wallet,verified) || !['free','paid'].includes(q.phase) || typeof q.priceWei !== 'string' || q.priceWei.length > 78 || !/^(0|[1-9][0-9]*)$/.test(q.priceWei) || BigInt(q.priceWei) >= (1n << 256n) || !Array.isArray(q.availableSlots) || q.availableSlots.length > 2048 || q.availableSlots.some(s => typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) || !Number.isFinite(q.validUntil) || q.validUntil <= Date.now()) throw new Error('Mint options could not be verified.');
          const snapshot={handle:q.handle,wallet:q.wallet,validUntil:q.validUntil,phase:q.phase,priceWei:q.priceWei};
          form.dataset.pulseQuote=JSON.stringify(snapshot);
          form.querySelector('input[name=pulse-mode][value=free]').disabled=q.phase !== 'free' || !q.availableSlots.length;
          form.querySelector('input[name=pulse-mode][value=paid]').disabled=q.phase !== 'paid';
          form.querySelector('input[name=pulse-max-eth]').disabled=q.phase !== 'paid';
          const wei=BigInt(q.priceWei), eth=(wei / 1000000000000000000n).toString()+'.'+(wei % 1000000000000000000n).toString().padStart(18,'0');
          message('[data-pulse-feedback]',q.phase === 'free' ? q.availableSlots.length ? 'Free mint available. Choose a slot-funded mint below.' : 'No unused free slot is available for this wallet.' : 'Current Pulse price: '+eth+' ETH. Choose paid mint and set your ceiling.');
        } catch(error) {clear();message('[data-pulse-feedback]',errorText(error), true);}
      });
    }
  });
  all('[data-assessment-request]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const handleField = form.querySelector('input[name=handle]');
    if (handleField?.checkValidity && !handleField.checkValidity()) return;
    if (!verified || walletBusy || mintBusy || requestBusy) { message('[data-request-feedback]', 'Connect and verify your wallet first.', true); return; }
    const requestedHandle = (form.querySelector('input[name=handle]')?.value || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(requestedHandle)) { message('[data-request-feedback]', 'Enter an X handle with 1–15 letters, numbers, or underscores.', true); return; }
    let mintIntent;
    if(form.dataset.pulseMint === 'true') {
      try {
        const q=JSON.parse(form.dataset.pulseQuote || 'null'), chosen=form.querySelector('input[name=pulse-mode]:checked');
        if(!q || q.validUntil <= Date.now() || q.handle !== requestedHandle.toLowerCase() || !sameAddress(q.wallet,verified) || !chosen || chosen.disabled || chosen.value !== q.phase) throw new Error('Check mint options and choose a mint mode first.');
        let maxPriceWei='0';
        if(chosen.value === 'paid') {
          const value=(form.querySelector('input[name=pulse-max-eth]')?.value || '').trim();
          if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)) throw new Error('Enter your maximum mint price in ETH.');
          const parts=value.split('.'); maxPriceWei=(BigInt(parts[0])*1000000000000000000n+BigInt((parts[1] || '').padEnd(18,'0'))).toString();
          if(BigInt(maxPriceWei) >= 2n**256n || BigInt(maxPriceWei) < BigInt(q.priceWei)) throw new Error('Your ceiling is below the quoted price or out of range.');
        }
        mintIntent={mode:chosen.value,maxPriceWei};
      } catch(error) {message('[data-request-feedback]',errorText(error), true);return;}
    }
    requestBusy = true; updateButtons();
    const recipient = verified, mode = walletMode, generation = walletGeneration;
    message('[data-request-feedback]', 'Grok is preparing your signature. Your wallet will ask you to mint when it is ready.');
    try {
      const state = await session();
      if (mode === 'injected') {
        const ethereum = provider(); await ensureChain(ethereum, state);
        await walletUnchanged(ethereum, state, recipient, generation);
        await supportedAccount(ethereum, recipient);
      }
      const result = await post('/api/assessments', { handle: requestedHandle, ...(mintIntent ? {mintIntent} : {}) }, () => {
        if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient) || walletMode !== mode) throw new Error('The wallet changed. Connect it again before preparing a signature.');
      });
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || !codePattern.test(result.code || '') || url.pathname !== '/mint/' + result.code || url.search || url.hash || result.handle !== requestedHandle.toLowerCase() || !/^\d+$/.test(String(result.tokenId))) throw new Error('The assessment returned an invalid result link.');
      if (!sameAddress(verified, recipient) || walletMode !== mode || stopped) throw new Error('The wallet changed. Open the prepared request to continue.');
      storageSet('intent:' + result.code, { code: result.code, handle: result.handle, tokenId: String(result.tokenId), wallet: recipient, mode, chain: expectedChain(state), contract: root.dataset.contract, expiresAt: Date.now() + 10 * 60 * 1000 });
      location.assign(url.pathname);
    } catch (error) {
      recoverError(error);
      if (error?.code === 'ALREADY_MINTED' && typeof error.url === 'string' && error.url === '/signatures/' + requestedHandle.toLowerCase()) location.assign(error.url);
      else message('[data-request-feedback]', errorText(error), error?.code !== 4001 && error?.code !== 'ACTION_REJECTED');
    } finally { requestBusy = false; updateButtons(); }
  }));
  all('[data-connect-wallet]').forEach((button) => button.addEventListener('click', async () => {
    if (stopped || walletBusy || mintBusy || requestBusy || submittedHash || uncertainSubmission || requestExpired()) return;
    walletBusy = true; button.disabled = true; invalidateWallet();
    try {
      feedback('Choose your wallet…');
      const choice = await chooseWallet(button);
      if (!choice || stopped) { feedback('Wallet connection cancelled. Choose Connect wallet when ready.'); return; }
      bindWallet(choice);
      const ethereum = provider(), state = await session();
      const address = (await ethereum.request({ method: 'eth_requestAccounts' }))?.[0];
      if (!addressPattern.test(address || '') || /^0x0{40}$/i.test(address)) throw new Error('The wallet returned no valid address. Unlock it and select an account, then reconnect.');
      await ensureChain(ethereum, state);
      const generation = walletGeneration;
      await walletUnchanged(ethereum, state, address, generation, false);
      await supportedAccount(ethereum, address);
      await walletUnchanged(ethereum, state, address, generation, false);
      const proof = await post('/api/wallet/challenge', { address, ...(code ? { code } : {}) });
      if (!proof.challengeId || typeof proof.message !== 'string' || !proof.message || (proof.address && !sameAddress(proof.address, address)) || (proof.code && proof.code !== code)) throw new Error('The wallet proof does not match this request. Nothing was signed.');
      await ensureChain(ethereum, state);
      await walletUnchanged(ethereum, state, address, generation, false);
      feedback('Sign the one-time message to verify your wallet. This does not send a transaction.');
      const signature = await ethereum.request({ method: 'personal_sign', params: [proof.message, address] });
      await walletUnchanged(ethereum, state, address, generation, false);
      const result = await post('/api/wallet/verify', { challengeId: proof.challengeId, signature });
      if (!sameAddress(walletAddress(result), address)) throw new Error('The verified wallet does not match the selected account.');
      await walletUnchanged(ethereum, state, address, generation, false);
      walletReady(address, state, 'injected');
      syncDeadlines(result);
      if (one('[data-collection-page]')) { location.reload(); return; }
      feedback('Wallet connected. Choose Mint & reveal when ready.');
    } catch (error) { invalidateWallet(); recoverError(error); const cancelled = error?.code === 4001 || error?.code === 'ACTION_REJECTED'; feedback(cancelled ? 'Cancelled in your wallet. Choose Connect wallet to connect and verify when ready.' : errorText(error), !cancelled); }
    finally { walletBusy = false; button.disabled = false; updateButtons(); if (!stopped) button.focus(); }
  }));
  one('[data-mint-form]')?.addEventListener('submit', async (event) => { event.preventDefault(); await submitMint('injected'); });
  if (local) {
    one('[data-dev-wallet]')?.addEventListener('click', async (event) => {
      if (stopped || walletBusy || mintBusy || requestBusy || submittedHash || uncertainSubmission || requestExpired()) return;
      const button = event.currentTarget;
      walletBusy = true; button.disabled = true; invalidateWallet();
      try {
        const state = await session();
        if (expectedChain(state) !== '0x7a69') throw new Error('The local test wallet is available only on chain 31337.');
        const result = await post('/api/dev/wallet', code ? { code } : {});
        walletReady(walletAddress(result), state, 'local');
        syncDeadlines(result);
        if (one('[data-collection-page]')) { location.reload(); return; }
        message('[data-dev-feedback]', 'Local test wallet connected. Mint & reveal uses this isolated test chain.'); feedback('Local test wallet connected.');
      } catch (error) { recoverError(error); message('[data-dev-feedback]', errorText(error), true); }
      finally { walletBusy = false; button.disabled = false; updateButtons(); }
    });
    one('[data-dev-mint]')?.addEventListener('click', async () => submitMint('local'));
  }
  one('[data-copy-handoff]')?.addEventListener('click', async () => {
    const field = one('[data-handoff-prompt]'); if (!field) return;
    try { await navigator.clipboard.writeText(field.value); message('[data-copy-feedback]', 'Copied. Paste it into Grok.'); }
    catch { field.focus(); field.select(); message('[data-copy-feedback]', 'Select and copy the prompt above.', true); }
  });
  one('[data-disconnect-wallet]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled || mintBusy || requestBusy) return;
    button.disabled = true;
    try { await post('/api/session/logout', {}); invalidateWallet(); location.reload(); }
    catch (error) { feedback(errorText(error), true); button.disabled = false; }
  });
  const onAccounts = () => { if (walletBusy) walletGeneration++; else { invalidateWallet(); feedback('The wallet account changed. Connect it again before continuing.', true); } };
  const onChain = () => { const label = one('[data-mint-network]'); if (label) label.hidden = true; if (walletBusy) walletGeneration++; else { invalidateWallet(); feedback('The wallet network changed. Connect it again before continuing.', true); } };
  const onDisconnect = () => { invalidateWallet(); feedback('The selected wallet disconnected. Unlock it and reconnect. Any submitted mint is still being checked.', true); };
  bindWallet(wallets.restore(storageGet('wallet-provider')));
  window.addEventListener('pagehide', () => { stopped = true; bootGeneration++; assessmentGeneration++; mintGeneration++; inspectionGeneration++; clearTimeout(timer); clearTimeout(bootTimer); clearTimeout(expiryTimer); abort.abort(); cancelWalletChoice?.(); bindWallet(null); wallets.dispose(); }, { once: true });
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  const boot = async () => {
    if (stopped || (!page && !one('[data-assessment-request]'))) return;
    clearTimeout(bootTimer);
    booting = true;
    const generation = ++bootGeneration, wallet = walletGeneration;
    try {
      const state = await session(); if (stopped || generation !== bootGeneration) return;
      // Server guard survives storage loss, another tab and process restart.
      if (durableSubmission && code) {
        const saved = await readJson('/api/mints/status/' + encodeURIComponent(code), { cache: 'no-store' });
        if (stopped || generation !== bootGeneration) return;
        if (canRevealMint(saved?.state)) { reveal(saved.state); return; }
        if (saved?.state === 'pending') {
          page.dataset.mintState = 'pending'; storageRemove(intentKey);
          if (hashPattern.test(saved.transactionHash || '')) setPending(saved.transactionHash, walletAddress(state));
          else uncertainSubmission = true;
          schedule(pollMint, 100);
        }
      }
      readUnavailable = false; bootFailures = 0;
      if (bootFeedback && one(bootFeedback.selector)?.textContent === bootFeedback.rendered) message(bootFeedback.selector, '');
      bootFeedback = null;
      const savedMode = storageGet('wallet-mode');
      const mode = local && savedMode?.mode === 'local' && sameAddress(savedMode.address, walletAddress(state)) ? 'local' : 'injected';
      if (!selectedWallet && mode === 'injected') bindWallet(wallets.restore(storageGet('wallet-provider')));
      if (wallet === walletGeneration && (state.walletVerified === true || page?.dataset.walletProved === 'true')) {
        if (mode === 'local' || selectedWallet) walletReady(walletAddress(state), state, mode);
        else { storageRemove(intentKey); feedback('Choose and reconnect your wallet to continue. The previous wallet could not be identified.', true); }
      }
      syncDeadlines(state);
      if (submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending') { message('[data-assessment-status]', ui().status); return; }
      if (canRevealMint(page?.dataset.mintState)) { reveal(page.dataset.mintState); return; }
      if (requestExpired()) return;
      if (page?.dataset.assessmentState === 'pending') schedule(pollAssessment, 1500);
      else if (page?.dataset.assessmentState === 'ready') await resumeIntent();
    } catch (error) {
      if (!stopped && generation === bootGeneration) {
        recoverError(error);
        readUnavailable = true; storageRemove(intentKey);
        const retrying = !requestExpired() || submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending';
        const copy = errorText(error) + (retrying ? ' Checking again automatically; ' + (one('[data-check-progress]') ? 'choose Check progress to check now.' : 'reload this page to check now.') : '');
        const selector = page ? '[data-poll-feedback]' : '[data-request-feedback]';
        message(selector, copy, true); bootFeedback = { selector, rendered: one(selector)?.textContent };
        if (retrying) bootTimer = setTimeout(boot, retryDelay(++bootFailures));
      }
    } finally { if (!stopped && generation === bootGeneration) { booting = false; updateButtons(); } }
  };
  one('[data-check-progress]')?.addEventListener('click', async () => {
    if (stopped || booting || assessmentBusy || mintPollBusy) return;
    if (submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending') { clearTimeout(timer); await pollMint(); }
    else if (!requestExpired()) { await boot(); if (!readUnavailable && page?.dataset.assessmentState === 'pending') { clearTimeout(timer); await pollAssessment(); } }
  });
  // Restore the durable submission guard before session boot can hang or fail.
  const submission = code ? storageGet(submissionKey) : null;
  if (durableSubmission && codePattern.test(submission?.permit || '')) submissionPermit = submission.permit;
  if (submission && (hashPattern.test(submission.hash || '') || submission.uncertain === true)) {
    if (hashPattern.test(submission.hash || '')) {
      submittedHash = submission.hash; reportNeeded = !durableSubmission || Boolean(submissionPermit);
      submittedWallet = addressPattern.test(submission.wallet || '') ? submission.wallet : null;
      submittedAt = Number.isFinite(submission.submittedAt) && submission.submittedAt > 0 && submission.submittedAt <= Date.now() ? submission.submittedAt : Date.now();
      expectedNonce = isQuantity(submission.expectedNonce) ? submission.expectedNonce : null;
      storageSet(submissionKey, { ...submission, submittedAt });
      page.dataset.mintState = 'pending';
    } else uncertainSubmission = true;
    walletMode = local && submission.mode === 'local' ? 'local' : 'injected';
    storageRemove(intentKey);
    feedback(submittedHash ? 'Checking your submitted transaction before revealing.' : 'Check wallet activity. This page is checking for a confirmed mint before any retry.', !submittedHash);
  }
  if (submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending') schedule(pollMint, 100);
  if (page) syncDeadlines(page.dataset);
  updateButtons(); void boot();
})();`;
