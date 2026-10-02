import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OPEN_MINT_CLIENT_SCRIPT, assessmentFailureText } from "./clientScript.js";

const WALLET = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const CONTRACT = `0x${"3".repeat(40)}`;
const HASH = `0x${"4".repeat(64)}`;
const BLOCK_HASH = `0x${"5".repeat(64)}`;
const NETWORK = { chainId: '0x7a69', contract: CONTRACT, blockNumber: '0xa', blockHash: BLOCK_HASH };
const PENDING_TRANSACTION = { hash: HASH, from: WALLET, to: CONTRACT, nonce: '0x1', blockNumber: null };
const SUBMISSION_KEY = 'sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const RECEIPT = { transactionHash: HASH, from: WALLET, to: CONTRACT, blockNumber: '0xb', blockHash: BLOCK_HASH, status: '0x0' };
type Listener = (event: any) => unknown;
class Element {
  dataset: Record<string, string> = {};
  listeners: Record<string, Listener> = {};
  children: Record<string, Element> = {};
  disabled = false;
  checked = false;
  hidden = false;
  value = "";
  private text = "";
  private classes = new Set<string>();
  get textContent(): string { return this.text + this.nodes.map(node => node.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.nodes = []; }
  get className(): string { return [...this.classes].join(" "); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
  };
  ownerDocument = {
    createElement: () => new Element(),
    createTextNode: (text: string) => { const node = new Element(); node.textContent = text; return node; },
  };
  type = "";
  nodes: Element[] = [];
  attributes: Record<string, string> = {};
  open = false;
  removed = false;
  addEventListener(type: string, listener: Listener) { this.listeners[type] = listener; }
  querySelector(selector: string) { return selector === 'input[name=pulse-mode]:checked' ? Object.values(this.children).find(e => e.checked) ?? null : this.children[selector] ?? null; }
  querySelectorAll(selector: string) { return selector === 'input[name=pulse-mode]' ? Object.entries(this.children).filter(([k]) => k.startsWith('input[name=pulse-mode][value=')).map(([,v]) => v) : []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...nodes: Element[]) { this.nodes.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.text = ""; this.nodes = nodes; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  focus() {}
  select() {}
  async emit(type: string) {
    const event: { preventDefault(): void; currentTarget: Element | null } = { preventDefault() {}, currentTarget: this };
    const result = this.listeners[type]?.(event);
    // Native dispatch clears currentTarget before an async listener resumes.
    event.currentTarget = null;
    return result;
  }
}
type SetupOptions = {
  durable?: boolean;
  pulseMaxPriceWei?: string;
  pulseEntry?: boolean;
  entry?: boolean;
  initialHandle?: string;
  preview?: boolean;
  pending?: boolean;
  support?: boolean;
  walletProved?: boolean;
  local?: boolean;
  storage?: Map<string, string>;
  accounts?: () => string[];
  api?: (path: string, body: any) => unknown;
  authorize?: Record<string, unknown>;
  duringAuthorize?: () => void;
  walletRequest?: (method: string, params: unknown) => unknown;
  now?: () => number;
  expiresAt?: number;
  proofExpiresAt?: number;
  serverNow?: number;
  expired?: boolean;
  mintState?: string;
  mintHash?: string;
  response?: (path: string) => { ok: boolean; json: () => Promise<unknown> } | undefined;
  providerKey?: string | null;
  configureWindow?: (window: any) => void;
};
const flush = async () => { for (let i = 0; i < 250; i++) await Promise.resolve(); };
function setup(options: SetupOptions = {}) {
  const selectors = ['[data-open-mint]', '[data-connect-wallet]', '[data-mint-feedback]', '[data-poll-feedback]', '[data-wallet-label]', '[data-disconnect-wallet]', '[data-copy-handoff]', '[data-handoff-prompt]', '[data-copy-feedback]', ...(options.preview ? [] : options.entry ? ['[data-assessment-request]', '[data-request-feedback]'] : ['[data-assessment-code]', '[data-assessment-status]', '[data-submit-mint]', '[data-mint-form]', '[data-request-recovery]', '[data-request-recovery-message]', '[data-check-progress]', '[data-mint-transaction]', '[data-mint-network]']), ...(options.local ? ['[data-dev-wallet]', '[data-dev-mint]', '[data-dev-feedback]'] : [])];
  const elements: Record<string, Element> = Object.fromEntries(selectors.map(selector => [selector, new Element()]));
  if (options.support) { elements['[data-assessment-support]'] = new Element(); elements['[data-assessment-support]'].hidden = true; }
  elements['[data-open-mint]'].dataset = { chainId: "31337", contract: CONTRACT, localChain: String(Boolean(options.local)), durableWalletSubmission: String(Boolean(options.durable)) };
  if (elements['[data-assessment-code]']) elements['[data-assessment-code]'].dataset = { assessmentCode: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", assessmentHandle: "agent_art", tokenId: "123", assessmentState: options.pending ? "pending" : "ready", canMint: "true", mintState: options.mintState ?? "unminted", walletProved: String(Boolean(options.walletProved)), requestExpired: String(Boolean(options.expired)), requestExpiresAt: String(options.expiresAt ?? ''), walletProofExpiresAt: String(options.proofExpiresAt ?? ''), serverNow: String(options.serverNow ?? '') };
  if (elements['[data-assessment-code]']) elements['[data-assessment-code]'].dataset.mintTransactionHash = options.mintHash ?? '';
  if (elements['[data-assessment-code]'] && options.pulseMaxPriceWei !== undefined) elements['[data-assessment-code]'].dataset.pulseMaxPriceWei = options.pulseMaxPriceWei;
  if (elements['[data-mint-network]']) elements['[data-mint-network]'].hidden = true;
  if (options.entry) {
    elements['[data-assessment-request]'].children = { 'button[type=submit]': new Element(), 'input[name=handle]': new Element() };
    elements['[data-assessment-request]'].children['input[name=handle]'].value = options.initialHandle ?? " @Agent_Art ";
    if (options.pulseEntry) {
      const form=elements['[data-assessment-request]']; form.dataset.pulseMint='true';
      for (const mode of ['free','paid']) { const e=new Element(); e.value=mode; e.disabled=true; form.children[`input[name=pulse-mode][value=${mode}]`]=e; }
      form.children['input[name=pulse-max-eth]']=new Element(); form.children['input[name=pulse-max-eth]'].disabled=true;
      form.children['[data-pulse-check]']=new Element(); elements['[data-pulse-feedback]']=new Element();
    }
  }
  const requests: Array<{ path: string; body: any; init: any }> = [];
  const walletCalls: Array<{ method: string; params: unknown }> = [];
  const scheduled: Array<(() => Promise<void>) & { delay?: number }> = [];
  const timers = new Map<number, () => Promise<void>>();
  let nextTimerId = 0;
  const globalEvents: Record<string, Listener> = {};
  const walletEvents: Record<string, Listener> = {};
  const navigations: string[] = [];
  const storage = options.storage ?? new Map<string, string>();
  if (options.providerKey !== null && !storage.has('sg-open:wallet-provider')) storage.set('sg-open:wallet-provider', JSON.stringify(options.providerKey ?? 'legacy:rabby'));
  let reloads = 0;
  let chain = "0x7a69";
  const state = { csrfToken: "csrf", wallet: WALLET, walletVerified: Boolean(options.walletProved), chainId: "31337", chainName: "Local chain", rpcUrl: "http://127.0.0.1:8545" };
  const window = {
    addEventListener(type: string, cb: Listener) { globalEvents[type] = cb; },
    removeEventListener(type: string) { delete globalEvents[type]; },
    dispatchEvent(event: Event) { globalEvents[event.type]?.(event); return true; },
    ethereum: {
      isRabby: true,
      on(type: string, cb: Listener) { walletEvents[type] = cb; },
      removeListener(type: string) { delete walletEvents[type]; },
      async request({ method, params }: { method: string; params: unknown }) {
        walletCalls.push({ method, params });
        const custom = options.walletRequest?.(method, params);
        if (custom !== undefined) return custom;
        if (method === "eth_requestAccounts" || method === "eth_accounts") return options.accounts?.() ?? [WALLET];
        if (method === "eth_chainId") return chain;
        if (method === "eth_getBlockByNumber") return { number: (params as any)[0], hash: BLOCK_HASH };
        if (method === "eth_getTransactionCount") return '0x1';
        if (method === "eth_call") return '0x';
        if (method === "eth_getCode") return '0x';
        if (method === "wallet_switchEthereumChain") { chain = ((params as any)[0]).chainId; return null; }
        if (method === "personal_sign") return "0xsignature";
        if (method === "eth_sendTransaction") return HASH;
        if (method === "eth_getTransactionByHash") return { ...PENDING_TRANSACTION };
        if (method === "eth_getTransactionReceipt") return null;
        throw new Error(`Unexpected wallet method ${method}`);
      },
    },
  };
  options.configureWindow?.(window);
  const body = new Element();
  const context = {
    window,
    document: { body, createElement: () => new Element(), querySelector: (selector: string) => elements[selector] ?? null, querySelectorAll: (selector: string) => elements[selector] ? [elements[selector]] : [] },
    location: { origin: "https://example.test", hash: "", assign(path: string) { navigations.push(path); }, reload() { reloads += 1; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    URL, Event, AbortController, Date: class extends Date { static now() { return options.now?.() ?? Date.now(); } }, navigator: {},
    setTimeout(fn: () => Promise<void>, delay = 0) {
      const id = ++nextTimerId;
      const run = async () => { timers.delete(id); const index = scheduled.indexOf(run); if (index !== -1) scheduled.splice(index, 1); await fn(); };
      run.delay = delay; timers.set(id, run); scheduled.push(run); scheduled.sort((a, b) => (a.delay ?? 0) - (b.delay ?? 0)); return id;
    },
    clearTimeout(id: number) { const fn = timers.get(id); const index = fn ? scheduled.indexOf(fn) : -1; if (index !== -1) scheduled.splice(index, 1); timers.delete(id); },
    async fetch(path: string, init: any) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, init });
      const response = options.response?.(path); if (response) return response;
      const custom = await options.api?.(path, body);
      if (custom !== undefined) return { ok: !(custom as any).error || ['failed', 'abstained'].includes((custom as any).status), json: async () => custom };
      let result: unknown = {};
      if (path === "/api/session") result = state;
      else if (path.startsWith('/api/wallet/context')) result = { ...NETWORK, ...(path.includes('?address=') ? { nonce: '0x1' } : {}) };
      else if (path === "/api/assessments") result = { url: "/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", code: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", handle: body.handle.toLowerCase(), tokenId: "123", status: "pending" };
      else if (path === "/api/assessments/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr") result = { status: "ready", handle: "agent_art", tokenId: "123", canMint: true, walletProvedForCode: true };
      else if (path === "/api/wallet/challenge") result = { challengeId: "challenge", message: "Verify wallet", address: WALLET, ...(body.code ? { code: body.code } : {}) };
      else if (path === "/api/wallet/verify" || path === "/api/dev/wallet") result = { wallet: WALLET };
      else if (path === "/api/mints/authorize") {
        options.duringAuthorize?.();
        result = { expiresAt: new Date(Date.now() + 60_000).toISOString(), code: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", handle: "agent_art", tokenId: "123", network: { ...NETWORK, nonce: '0x1' }, transaction: { from: WALLET, to: CONTRACT, chainId: "31337", data: "0x1234", value: "0x0", nonce: '0x1' }, ...options.authorize };
      } else if (path === "/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr") result = { state: "pending" };
      else if (path === "/api/dev/mint") result = { transactionHash: HASH };
      return { ok: true, json: async () => result };
    },
  };
  runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context);
  return { elements, requests, walletCalls, scheduled, globalEvents, walletEvents, navigations, storage, state, window, body, reloads: () => reloads, rerun: () => runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context) };
}
function intent(storage = new Map<string, string>(), overrides = {}) {
  storage.set('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', JSON.stringify({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'agent_art', tokenId: '123', wallet: WALLET, mode: 'injected', chain: '0x7a69', contract: CONTRACT, expiresAt: Date.now() + 60_000, ...overrides }));
  return storage;
}
const sends = (test: ReturnType<typeof setup>) => test.walletCalls.filter(call => call.method === 'eth_sendTransaction');
const savedSubmission = (overrides = {}) => new Map([[SUBMISSION_KEY, JSON.stringify({ hash: HASH, wallet: WALLET, mode: 'injected', ...overrides })]]);
const ASSESSMENT_PATH = '/api/assessments/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const INTENT_KEY = 'sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const readyStatus = { handle: 'agent_art', tokenId: '123', status: 'ready', canMint: true, walletProvedForCode: true };
const tick = (test: ReturnType<typeof setup>, delay: number) => {
  const timer = test.scheduled.find(timer => timer.delay === delay);
  expect(timer, `Expected a ${delay}ms timer`).toBeDefined();
  return timer!();
};

describe('shared inline warning feedback', () => {
  it('styles wallet failures and restores plain successful feedback without changing transaction behavior', async () => {
    let fail = true;
    const test = setup({ entry: true, walletRequest: method => {
      if (method === 'eth_requestAccounts' && fail) throw new Error('Wallet access could not be completed.');
    } });
    await flush();
    const feedback = test.elements['[data-mint-feedback]'];
    feedback.className = 'open-feedback retained-class';
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(feedback.classList.contains('open-preview-warning')).toBe(true);
    expect(feedback.classList.contains('open-preview-notice')).toBe(true);
    expect(feedback.nodes[0].className).toBe('open-preview-notice-label');
    expect(feedback.nodes[0].textContent).toBe('Warning');
    expect(feedback.nodes[2].textContent).toBe('Wallet access could not be completed.');
    expect(feedback.nodes[2].className).toBe('');
    fail = false;
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(feedback.textContent).toBe('Wallet connected. Choose Mint & reveal when ready.');
    expect(feedback.className).toBe('open-feedback retained-class');
    expect(sends(test)).toEqual([]);
    expect(test.requests.some(request => request.path === '/api/assessments')).toBe(false);
  });

  it('keeps a deliberate wallet cancellation plain, not a warning', async () => {
    const test = setup({ entry: true, walletRequest: method => {
      if (method === 'eth_requestAccounts') throw Object.assign(new Error('Rejected'), { code: 4001 });
    } });
    await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Cancelled in your wallet');
    expect(test.elements['[data-mint-feedback]'].classList.contains('open-preview-warning')).toBe(false);
    expect(sends(test)).toEqual([]);
  });

  it('styles missing wallet and invalid Pulse consent while keeping generation progress plain', async () => {
    const test = setup({ entry: true, pulseEntry: true, api: path => path.startsWith('/api/mints/options?')
      ? { version: 'sg-pulse-mint-options-v1', wallet: WALLET, handle: 'agent_art', phase: 'paid', priceWei: '1000000000000000', availableSlots: [], validUntil: Date.now() + 10000 }
      : undefined });
    await flush();
    const form = test.elements['[data-assessment-request]'];
    const feedback = test.elements['[data-request-feedback]'];
    await form.emit('submit');
    expect(feedback.textContent).toBe('Warning Connect and verify your wallet first.');
    expect(feedback.classList.contains('open-preview-warning')).toBe(true);
    await test.elements['[data-connect-wallet]'].emit('click');
    await form.children['[data-pulse-check]'].emit('click');
    expect(test.elements['[data-pulse-feedback]'].classList.contains('open-preview-warning')).toBe(false);
    form.children['input[name=pulse-mode][value=paid]'].checked = true;
    form.children['input[name=pulse-max-eth]'].value = 'invalid';
    await form.emit('submit');
    expect(feedback.textContent).toBe('Warning Enter your maximum mint price in ETH.');
    expect(test.requests.some(request => request.path === '/api/assessments')).toBe(false);
    form.children['input[name=pulse-max-eth]'].value = '0.002';
    await form.emit('submit');
    expect(feedback.textContent).toBe('Grok is preparing your signature. Your wallet will ask you to mint when it is ready.');
    expect(feedback.classList.contains('open-preview-warning')).toBe(false);
    expect(test.requests.filter(request => request.path === '/api/assessments')).toHaveLength(1);
    expect(sends(test)).toEqual([]);
  });
});

describe('durable generative wallet submission protocol', () => {
  it.each(['free','paid'])('requires a read-only quote and explicit %s consent before preparation', async phase => {
    const test=setup({entry:true,pulseEntry:true,walletProved:true,api:path => path.startsWith('/api/mints/options?') ? {version:'sg-pulse-mint-options-v1',wallet:WALLET,handle:'agent_art',phase,priceWei:phase==='paid' ? '1000000000000000' : '0',availableSlots:phase==='free' ? ['0','1'] : [],validUntil:Date.now()+10000} : undefined});
    await flush();
    const form=test.elements['[data-assessment-request]'];
    expect(test.requests.some(r=>r.path.startsWith('/api/mints/options?'))).toBe(false);
    await form.emit('submit'); await flush();
    expect(test.requests.some(r=>r.path==='/api/assessments')).toBe(false);
    await form.children['[data-pulse-check]'].emit('click'); await flush();
    expect(test.requests.some(r=>r.path==='/api/assessments')).toBe(false);
    expect(Object.values(form.children).some(e=>e.checked)).toBe(false);
    await form.emit('submit'); await flush();
    expect(test.requests.some(r=>r.path==='/api/assessments')).toBe(false);
    form.children[`input[name=pulse-mode][value=${phase}]`].checked=true;
    form.children['input[name=pulse-max-eth]'].value='0.002';
    await form.emit('submit'); await flush();
    expect(test.requests.find(r=>r.path==='/api/assessments')?.body.mintIntent).toEqual({mode:phase,maxPriceWei:phase==='paid' ? '2000000000000000' : '0'});
  });
  it('invalidates a checked Pulse quote when the handle changes', async () => {
    const test=setup({entry:true,pulseEntry:true,walletProved:true,api:path => path.startsWith('/api/mints/options?') ? {version:'sg-pulse-mint-options-v1',wallet:WALLET,handle:'agent_art',phase:'free',priceWei:'0',availableSlots:['0'],validUntil:Date.now()+10000} : undefined});
    await flush(); const form=test.elements['[data-assessment-request]'];
    await form.children['[data-pulse-check]'].emit('click');
    form.children['input[name=pulse-mode][value=free]'].checked=true;
    form.children['input[name=handle]'].value='Bob'; await form.children['input[name=handle]'].emit('input');
    await form.emit('submit'); await flush();
    expect(test.requests.some(r=>r.path==='/api/assessments')).toBe(false);
    expect(form.dataset.pulseQuote).toBeUndefined();
  });
  it('sends the exact saved Pulse ceiling, not zero or a response-selected amount', async () => {
    const transaction = { from: WALLET, to: CONTRACT, chainId: '0x7a69', data: '0x1234', value: '0x64', nonce: '0x1' };
    const test = setup({ durable: true, walletProved: true, pulseMaxPriceWei: '100', storage: intent(),
      authorize: { version: 'sg-pulse-wallet-plan-v1-rc1', transaction },
      api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : path === '/api/mints/begin' ? { permit: 'p'.repeat(43), transaction } : undefined });
    await flush();
    expect(sends(test)).toHaveLength(1);
    expect((sends(test)[0].params as any[])[0].value).toBe('0x64');
  });
  it.each([
    ['100', '0x0', 'sg-pulse-wallet-plan-v1-rc1'],
    ['100', '0x65', 'sg-pulse-wallet-plan-v1-rc1'],
    ['100', '0x064', 'sg-pulse-wallet-plan-v1-rc1'],
    ['100', '0x64', undefined],
    [undefined, '0x64', 'sg-pulse-wallet-plan-v1-rc1'],
    ['01', '0x1', 'sg-pulse-wallet-plan-v1-rc1'],
  ])('refuses a crossed Pulse payment binding (%s, %s, %s)', async (cap, value, version) => {
    const test = setup({ durable: true, walletProved: true, pulseMaxPriceWei: cap, storage: intent(),
      authorize: { version, transaction: { from: WALLET, to: CONTRACT, chainId: '31337', data: '0x1234', value, nonce: '0x1' } } });
    await flush();
    expect(sends(test)).toHaveLength(0);
    expect(test.requests.some(r => r.path === '/api/mints/begin')).toBe(false);
  });
  const permit = 'p'.repeat(43), transaction = { from: WALLET, to: CONTRACT, chainId: '0x7a69', data: '0x1234', value: '0x0', nonce: '0x1' };
  const api = (path: string) => path.startsWith('/api/mints/status/') ? { state: 'unminted' }
    : path === '/api/mints/begin' ? { permit, transaction } : undefined;
  it('commits a guard before sending, then reports with its permit', async () => {
    const test = setup({ durable: true, walletProved: true, storage: intent(), api }); await flush();
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.find(r => r.path === '/api/mints/begin')?.body).toEqual({ code: 'r'.repeat(43), consent: true });
    expect(test.requests.find(r => r.path === '/api/mints/report')?.body).toEqual({ code: 'r'.repeat(43), permit, transactionHash: HASH });
    expect(JSON.parse(test.storage.get(SUBMISSION_KEY)!)).toMatchObject({ permit, hash: HASH });
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(test.elements['[data-poll-feedback]'].textContent).not.toContain(HASH);
  });
  it.each(['lost', 'bad-permit', 'changed-transaction', 'conflict'])('does not send after %s begin response', async kind => {
    const test = setup({ durable: true, walletProved: true, storage: intent(), api(path) {
      if (path === '/api/mints/begin') {
        if (kind === 'lost') throw new Error('network lost');
        if (kind === 'bad-permit') return { permit: 'invalid', transaction };
        if (kind === 'changed-transaction') return { permit, transaction: { ...transaction, nonce: '0x2' } };
        return { error: 'Already started', code: 'SUBMISSION_UNRESOLVED' };
      }
      return api(path);
    } }); await flush();
    expect(sends(test)).toHaveLength(0); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('This page has not sent a wallet transaction.');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('wallet response is uncertain');
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(test.requests.some(r => r.path === '/api/mints/reject')).toBe(false);
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toHaveLength(0);
  });
  it.each([true, false])('wallet rejection requires a saved rejection before offering retry (%s)', async saved => {
    const test = setup({ durable: true, walletProved: true, storage: intent(), api(path) {
      if (path === '/api/mints/reject' && !saved) throw new Error('lost report');
      return api(path);
    }, walletRequest(method) { if (method === 'eth_sendTransaction') throw Object.assign(new Error('Rejected'), { code: 4001 }); } }); await flush();
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.filter(r => r.path === '/api/mints/reject')).toHaveLength(1);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(!saved);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(!saved);
  });
  it.each([true, false])('server pending guard survives missing browser storage; hash known=%s', async known => {
    const test = setup({ durable: true, walletProved: true, storage: intent(), api(path) {
      if (path.startsWith('/api/mints/status/')) return { state: 'pending', ...(known ? { transactionHash: HASH } : {}) };
      return api(path);
    } }); await flush();
    expect(sends(test)).toHaveLength(0); expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it('failed server guard read discards automatic intent before any wallet prompt', async () => {
    const test = setup({ durable: true, walletProved: true, storage: intent(), api(path) { if (path.startsWith('/api/mints/status/')) throw new Error('offline'); return api(path); } });
    await flush(); expect(sends(test)).toHaveLength(0); expect(test.storage.has(INTENT_KEY)).toBe(false);
  });
});

describe('injected wallet selection and account scope', () => {
  const extraWallet = (request?: (request: { method: string; params?: unknown }) => Promise<unknown>) => {
    const calls: string[] = [], events: Record<string, Listener> = {};
    return { calls, events, provider: { isMetaMask: true, on: (name: string, fn: Listener) => { events[name] = fn; }, removeListener: (name: string) => { delete events[name]; }, request: async (input: { method: string; params?: unknown }) => { calls.push(input.method); return request?.(input); } } };
  };

  it('waits for explicit multi-extension selection and sends all proof/mint calls only to that provider', async () => {
    let primary: any;
    const second = extraWallet(input => primary.request(input));
    const test = setup({ entry: true, providerKey: null, configureWindow: window => { primary = window.ethereum; window.ethereum = { providers: [primary, second.provider] }; } }); await flush();
    const connecting = test.elements['[data-connect-wallet]'].emit('click'); await flush();
    expect(test.walletCalls).toEqual([]); expect(second.calls).toEqual([]);
    const dialog = test.body.nodes[0]!;
    expect(dialog.attributes['aria-label']).toBe('Choose a wallet'); expect(dialog.open).toBe(true);
    expect(dialog.nodes[1]!.textContent).toContain('Rabby'); expect(dialog.nodes[2]!.textContent).toContain('MetaMask');
    await dialog.nodes[2]!.emit('click'); await connecting;
    expect(dialog.removed).toBe(true);
    expect(second.calls).toContain('personal_sign');
    expect(test.walletEvents).toEqual({}); expect(Object.keys(second.events)).toEqual(['accountsChanged', 'chainChanged', 'disconnect']);
    expect(JSON.parse(test.storage.get('sg-open:wallet-provider')!)).toBe('legacy:metamask');
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(second.calls.filter(method => method === 'eth_getCode')).toHaveLength(2);
    expect(test.navigations).toHaveLength(1);
  });

  it.each(['cancel', 'escape', 'pagehide'])('cancels wallet selection with %s without account access or proof', async how => {
    const second = extraWallet();
    const test = setup({ providerKey: null, configureWindow: window => { window.ethereum.providers = [window.ethereum, second.provider]; } }); await flush();
    const connecting = test.elements['[data-connect-wallet]'].emit('click'); await flush(); const dialog = test.body.nodes[0]!;
    if (how === 'pagehide') test.globalEvents.pagehide({});
    else await (how === 'escape' ? dialog.emit('cancel') : dialog.nodes.at(-1)!.emit('click'));
    await connecting;
    expect(dialog.removed).toBe(true); expect(test.walletCalls).toEqual([]); expect(second.calls).toEqual([]);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it('keeps the selected object and removes its listeners when window.ethereum is replaced', async () => {
    const test = setup({ walletProved: true }); await flush();
    const replacement = extraWallet(); test.window.ethereum = replacement.provider as any;
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(replacement.calls).toEqual([]);
    test.globalEvents.pagehide({}); expect(test.walletEvents).toEqual({}); expect(replacement.events).toEqual({});
  });

  it('moves listeners only after explicitly selecting another wallet on reconnect', async () => {
    let primary: any; const second = extraWallet(input => primary.request(input));
    const test = setup({ walletProved: true, configureWindow: window => { primary = window.ethereum; window.ethereum.providers = [primary, second.provider]; } }); await flush();
    const oldAccounts = test.walletEvents.accountsChanged;
    const connecting = test.elements['[data-connect-wallet]'].emit('click'); await flush();
    await test.body.nodes[0]!.nodes[2]!.emit('click'); await connecting;
    expect(test.walletEvents).toEqual({}); expect(second.events.accountsChanged).toBe(oldAccounts);
    second.events.accountsChanged([OTHER]);
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('account changed');
  });

  it.each([null, 'legacy:metamask'])('does not restore or auto-mint a verified session with missing provider identity %s', async providerKey => {
    const test = setup({ walletProved: true, storage: intent(), providerKey }); await flush();
    expect(test.walletCalls).toEqual([]); expect(sends(test)).toEqual([]); expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('previous wallet could not be identified');
  });

  it('restores the selected EIP-6963 provider by unique RDNS and ignores provider icon markup', async () => {
    let primary: any; const second = extraWallet(input => primary.request(input));
    const test = setup({ walletProved: true, providerKey: 'eip6963:io.metamask', configureWindow: window => {
      primary = window.ethereum;
      window.dispatchEvent = (event: Event) => { if (event.type === 'eip6963:requestProvider') window.announce?.(); return true; };
      const listen = window.addEventListener;
      window.addEventListener = (name: string, handler: Listener) => {
        listen(name, handler);
        if (name === 'eip6963:announceProvider') window.announce = () => handler({ detail: { info: { uuid: '00000000-0000-4000-8000-000000000001', name: '<img onerror=bad()>', rdns: 'io.metamask', icon: 'data:image/svg+xml,<svg onload=bad() />' }, provider: second.provider } });
      };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(second.calls).toContain('eth_sendTransaction'); expect(test.walletEvents).toEqual({});
    expect(test.body.nodes).toEqual([]);
  });

  it('invalidates a disconnected wallet without releasing an unresolved submission', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission() }); await flush();
    test.walletEvents.disconnect({ code: 4900 });
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await tick(test, 100); expect(test.requests.some(request => request.path.startsWith('/api/mints/status/'))).toBe(true);
    expect(sends(test)).toEqual([]);
  });

  it.each(['0x6000', '0xef0100' + '1'.repeat(40)])('rejects on-chain code %s before signing or starting an assessment regardless of brand', async bytecode => {
    const test = setup({ entry: true, walletRequest: method => method === 'eth_getCode' ? bytecode : undefined }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls.some(call => call.method === 'personal_sign')).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('delegated or other code-bearing accounts');
    expect(test.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(true);
  });

  it.each(['assessment', 'mint'])('checks changed account code before %s authority is requested', async action => {
    const test = setup({ entry: action === 'assessment', walletProved: true, walletRequest: method => method === 'eth_getCode' ? '0xef0100' + '2'.repeat(40) : undefined }); await flush();
    await test.elements[action === 'assessment' ? '[data-assessment-request]' : '[data-mint-form]'].emit('submit');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]); expect(sends(test)).toEqual([]);
  });

  it.each([{ accounts: [] }, { accounts: ['invalid'] }, { accounts: ['0x' + '0'.repeat(40)] }])('handles empty or invalid account responses $accounts without signing', async ({ accounts }) => {
    const test = setup({ accounts: () => accounts }); await flush(); await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.some(call => call.method === 'personal_sign')).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Unlock it and select an account');
  });

  it.each([4001, 'ACTION_REJECTED', 4100, 4200, -32601])('leaves connection rejection or unsupported method %s recoverable', async code => {
    let failed = true;
    const test = setup({ walletRequest: method => { if (method === 'personal_sign' && failed) throw Object.assign(new Error('raw provider error'), { code }); } }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.elements['[data-connect-wallet]'].disabled).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('raw provider error');
    expect(test.requests.some(request => request.path === '/api/wallet/verify')).toBe(false);
    failed = false; await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.filter(request => request.path === '/api/wallet/verify')).toHaveLength(1);
    expect(sends(test)).toEqual([]);
  });
});

describe('actionable mint recovery', () => {
  const reference = '12345678-1234-4123-8123-123456789abc';

  it('waits out a reservation and checks availability only after explicit continuation', async () => {
    let now = Date.now(), reserved = true;
    const test = setup({ walletProved: true, now: () => now, api: path => path === '/api/mints/authorize' && reserved ? { error: 'Reserved', code: 'MINT_RESERVED', category: 'reservation', reservedUntil: new Date(now + 5000).toISOString() } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('reserved until');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('UTC');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toHaveLength(1);
    now += 5000; await tick(test, 5000);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Choose Continue mint to check availability');
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toHaveLength(1);
    reserved = false; await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toHaveLength(2);
  });

  it.each([undefined, 'not-a-time', '<script>alert(1)</script>'])('does not invent a reservation deadline from %s', async reservedUntil => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/authorize' ? { error: 'Reserved', code: 'MINT_RESERVED', reservedUntil } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Wait for its window to end');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toMatch(/Invalid Date|<script>|not-a-time/);
    expect(sends(test)).toEqual([]);
    expect(test.scheduled).toEqual([]);
  });

  it('does not enable a reserved request that expires before the reservation ends', async () => {
    let now = Date.now();
    const test = setup({ walletProved: true, now: () => now, serverNow: now, expiresAt: now + 1000,
      api: path => path === '/api/mints/authorize' ? { error: 'Reserved', code: 'MINT_RESERVED', reservedUntil: new Date(now + 5000).toISOString() } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); now += 1000; await tick(test, 1000); now += 4000; await tick(test, 4000);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-request-recovery]'].hidden).toBe(false);
    expect(sends(test)).toEqual([]);
  });

  it('requires a fresh wallet proof after authorization rejects an expired proof', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/authorize' ? { error: 'Proof expired', code: 'WALLET_PROOF_REQUIRED' } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('wallet-required');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Connect and verify');
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toHaveLength(1);
    expect(test.requests.filter(request => request.path === '/api/wallet/challenge')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it.each(['SESSION_REQUIRED', 'CSRF_INVALID', 'REQUEST_SESSION_MISMATCH', 'REQUEST_WALLET_MISMATCH'])('offers safe return and reconnect for %s without reopening mint authority', async code => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/authorize' ? { error: 'No session', code } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-request-recovery]'].hidden).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Return to mint and reconnect');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.path === '/api/assessments')).toEqual([]);
  });

  it.each(['INSUFFICIENT_FUNDS', 'NETWORK_ERROR'])('makes the pre-send wallet error %s actionable without a transaction retry', async code => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_call') throw Object.assign(new Error('Wallet check failed'), { code }); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain(code === 'INSUFFICIENT_FUNDS' ? 'balance on the mint network' : 'Restore the configured network/RPC');
    expect(sends(test)).toEqual([]);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toHaveLength(1);
  });

  it('keeps an uncertain send guarded even if its wallet error mentions funds', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_sendTransaction') throw Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' }); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('uncertain');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
  });

  it.each(['assessment-blocked', 'assessment-abstained', 'preparation-interrupted'])('projects %s with only its safe operator reference and no retry', async errorCategory => {
    const status = errorCategory === 'assessment-abstained' ? 'abstained' : 'failed';
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path === ASSESSMENT_PATH ? { ...readyStatus, status, error: 'private-provider-payload', errorCategory, diagnosticReference: reference } : undefined }); await flush(); await tick(test, 1500);
    expect(test.elements['[data-mint-feedback]'].textContent).toBe('Warning ' + assessmentFailureText({ errorCategory, diagnosticReference: reference }));
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('private-provider-payload');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain(reference);
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it.each(['failed', 'abstained'])('reveals the configured support placeholder after a live %s result', async status => {
    const errorCategory = status === 'abstained' ? 'assessment-abstained' : 'assessment-blocked';
    const test = setup({ pending: true, support: true, walletProved: true,
      api: path => path === ASSESSMENT_PATH ? { ...readyStatus, status, errorCategory, diagnosticReference: reference } : undefined });
    expect(test.elements['[data-assessment-support]'].hidden).toBe(true);
    await flush(); await tick(test, 1500);
    expect(test.elements['[data-assessment-support]'].hidden).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain(reference);
    expect(test.navigations).toEqual([]);
    expect(test.requests.every(request => request.path.startsWith('/api/'))).toBe(true);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it('keeps support hidden when preparation succeeds and creates no unconfigured destination', async () => {
    const configured = setup({ pending: true, support: true, walletProved: true });
    await flush(); await tick(configured, 1500);
    expect(configured.elements['[data-assessment-code]'].dataset.assessmentState).toBe('ready');
    expect(configured.elements['[data-assessment-support]'].hidden).toBe(true);
    const unconfigured = setup({ pending: true, api: path => path === ASSESSMENT_PATH ? { ...readyStatus, status: 'failed', errorCategory: 'assessment-blocked' } : undefined });
    await flush(); await tick(unconfigured, 1500);
    expect(unconfigured.elements['[data-assessment-support]']).toBeUndefined();
  });

  it.each([reference, 'legacy-1234567890abcdef12345678', 'r'.repeat(43), '/mint/private', '<script>alert(1)</script>'])('only exposes an allowed diagnostic reference: %s', async diagnostic => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { error: 'Do not expose raw backend details', code: 'ASSESSMENT_RETRY_BLOCKED', reference: diagnostic, category: 'assessment' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    const copy = test.elements['[data-request-feedback]'].textContent;
    expect(copy).toContain('operator review');
    expect(copy.includes(diagnostic)).toBe(diagnostic === reference || diagnostic.startsWith('legacy-'));
    expect(copy).not.toContain('raw backend details');
    expect(test.navigations).toEqual([]);
    expect(test.requests.filter(request => request.path === '/api/assessments')).toHaveLength(1);
  });

  it('shows the known transaction independently of errors and labels only a verified network', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { error: 'Unavailable' } : undefined }); await flush();
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(test.elements['[data-mint-network]'].hidden).toBe(true);
    await tick(test, 100);
    expect(test.elements['[data-mint-network]'].textContent).toBe('Verified mint network: chain 31337.');
    expect(test.elements['[data-mint-network]'].hidden).toBe(false);
    test.walletEvents.chainChanged('0x1');
    expect(test.elements['[data-mint-network]'].hidden).toBe(true);
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(sends(test)).toEqual([]);
  });

  it('keeps a server-known pending hash visible even without browser submission storage', async () => {
    const test = setup({ mintState: 'pending', mintHash: HASH, api: path => path.startsWith('/api/mints/status/') ? { state: 'pending', transactionHash: HASH } : undefined }); await flush(); await tick(test, 100);
    expect(test.elements['[data-mint-transaction]'].hidden).toBe(false);
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(test.elements['[data-mint-network]'].hidden).toBe(true);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it('does not restore a verified network label from a check that outlives a wallet change', async () => {
    let release!: (block: unknown) => void;
    const block = new Promise(resolve => { release = resolve; });
    const test = setup({ walletProved: true, walletRequest: method => method === 'eth_getBlockByNumber' ? block : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    test.walletEvents.chainChanged('0x1'); release({ number: NETWORK.blockNumber, hash: BLOCK_HASH }); await submission;
    expect(test.elements['[data-mint-network]'].hidden).toBe(true);
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it('does not promise automatic session recovery after the request must be reopened', async () => {
    const test = setup({ api: path => path === '/api/session' ? { error: 'No session', code: 'SESSION_REQUIRED' } : undefined }); await flush();
    expect(test.elements['[data-request-recovery]'].hidden).toBe(false);
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('Return to mint and reconnect');
    expect(test.elements['[data-poll-feedback]'].textContent).not.toContain('automatically');
    expect(test.scheduled).toEqual([]);
  });
});

describe('request expiry and bounded read recovery', () => {
  it.each([false, true])('expires an idle request while pending=%s without posting, signing, or losing its saved-result return', async pending => {
    let now = Date.now();
    const test = setup({ pending, now: () => now, serverNow: now, expiresAt: now + 1000, walletProved: true, storage: pending ? intent() : undefined });
    await flush(); now += 1000; await tick(test, 1000);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('expired');
    expect(test.elements['[data-request-recovery]'].hidden).toBe(false);
    expect(test.elements['[data-request-recovery-message]'].textContent).toContain('saved assessment and artwork will be reused');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    await test.elements['[data-mint-form]'].emit('submit');
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls).toEqual([]);
  });

  it('honors server-observed expiry, including while assessment is still pending', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path === ASSESSMENT_PATH ? { ...readyStatus, status: 'pending', requestExpired: true } : undefined });
    await flush(); await tick(test, 1500);
    expect(test.elements['[data-assessment-code]'].dataset.requestExpired).toBe('true');
    expect(test.elements['[data-assessment-status]'].textContent).toContain('expired');
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(sends(test)).toEqual([]);
    expect(test.requests.every(request => !request.init.method)).toBe(true);
  });

  it('uses the server clock for a request deadline despite browser clock skew', async () => {
    let now = Date.now() + 3_600_000;
    const serverNow = now - 3_600_000;
    const test = setup({ now: () => now, serverNow, expiresAt: serverNow + 5000, walletProved: true }); await flush();
    expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
    now += 5000; await tick(test, 5000);
    expect(test.elements['[data-assessment-status]'].textContent).toContain('expired');
  });

  it('invalidates an idle wallet proof without creating a new challenge or assessment', async () => {
    let now = Date.now();
    const test = setup({ now: () => now, serverNow: now, proofExpiresAt: now + 1000, walletProved: true }); await flush();
    now += 1000; await tick(test, 1000);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('wallet-required');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls).toEqual([]);
  });

  it('expires a pending one-shot intent without silently renewing it', async () => {
    let now = Date.now();
    const test = setup({ pending: true, walletProved: true, now: () => now, storage: intent(undefined, { expiresAt: now + 1000 }) }); await flush();
    now += 1000; await tick(test, 1000); await tick(test, 1500);
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(sends(test)).toEqual([]);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('ready');
  });

  it('blocks a late authorization when the request expires during preparation', async () => {
    let now = Date.now(), release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const test = setup({ walletProved: true, now: () => now, serverNow: now, expiresAt: now + 1000, api: path => path === '/api/mints/authorize' ? wait : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    now += 1000; await tick(test, 1000); release(); await submission;
    expect(sends(test)).toEqual([]);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('expired');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
  });

  it.each(['hash', 'reject', 'unknown'])('keeps the wallet approval authoritative across request expiry: %s', async outcome => {
    let now = Date.now(), resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const approval = new Promise((yes, no) => { resolve = yes; reject = no; });
    const test = setup({ walletProved: true, now: () => now, serverNow: now, expiresAt: now + 1000, walletRequest: method => method === 'eth_sendTransaction' ? approval : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    now += 1000; await tick(test, 1000);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('wallet-approval');
    expect(test.elements['[data-request-recovery]'].hidden).toBe(true);
    if (outcome === 'hash') resolve(HASH);
    else reject(Object.assign(new Error('Wallet closed'), outcome === 'reject' ? { code: 4001 } : {}));
    await submission;
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe(outcome === 'hash' ? 'submitted' : outcome === 'unknown' ? 'uncertain' : 'expired');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(outcome !== 'reject');
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1);
  });

  it.each(['hash', 'unknown', 'server-pending'])('continues reconciliation for an already expired request with %s', async kind => {
    const test = setup({ expired: true, walletProved: true, storage: kind === 'hash' ? savedSubmission() : kind === 'unknown' ? new Map([[SUBMISSION_KEY, JSON.stringify({ uncertain: true, wallet: WALLET })]]) : undefined,
      mintState: kind === 'server-pending' ? 'pending' : 'unminted', api: path => path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined }); await flush();
    expect(test.elements['[data-request-recovery]'].hidden).toBe(true);
    await tick(test, 100);
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it('reveals on verified inclusion without losing the submission guard or replaying an expired mint', async () => {
    const storage = savedSubmission();
    const test = setup({ expired: true, walletProved: true, storage,
      api: path => path.startsWith('/api/mints/status/') ? { state: 'confirming' } : undefined });
    await flush(); await tick(test, 100);
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(storage.has(SUBMISSION_KEY)).toBe(true);
    expect(storage.has(INTENT_KEY)).toBe(false);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it('reveals confirming assessment status without submitting another transaction', async () => {
    const test = setup({ pending: true, api: path => path === ASSESSMENT_PATH ? { ...readyStatus, mint: { state: 'confirming' } } : undefined });
    await flush(); await tick(test, 1500);
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.path === '/api/mints/authorize')).toEqual([]);
  });

  it('returns an expired reverted transaction to request recovery, never Continue mint', async () => {
    const test = setup({ walletProved: true, expired: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined,
      walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, blockNumber: RECEIPT.blockNumber } : method === 'eth_getTransactionReceipt' ? RECEIPT : undefined }); await flush(); await tick(test, 100);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-request-recovery]'].hidden).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Return to mint');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('Continue mint');
  });

  it.each(['fetch', 'body'])('reconciles a saved transaction even when the session %s never completes', async hang => {
    const never = new Promise(() => {});
    const test = setup({ storage: savedSubmission(), api: path => path === '/api/session' && hang === 'fetch' ? never : path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined,
      response: path => path === '/api/session' && hang === 'body' ? { ok: true, json: () => never } : undefined }); await flush();
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await tick(test, 100);
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it.each(['fetch', 'body'])('bounds a hung session %s and recovers through reads without reviving automatic mint intent', async hang => {
    let failed = true, release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const test = setup({ walletProved: true, storage: intent(), api: path => path === '/api/session' && failed && hang === 'fetch' ? pending : undefined,
      response: path => path === '/api/session' && failed && hang === 'body' ? { ok: true, json: () => pending } : undefined }); await flush();
    await tick(test, 8000); await flush();
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('read-unavailable');
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('choose Check progress to check now');
    expect(test.elements['[data-poll-feedback]'].textContent).not.toContain('reload this page to check now');
    expect(test.elements['[data-poll-feedback]'].classList.contains('open-preview-warning')).toBe(true);
    expect(test.requests[0].init.signal.aborted).toBe(true);
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    failed = false; await tick(test, 5000); await flush();
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('ready');
    expect(test.elements['[data-poll-feedback]'].textContent).toBe('');
    expect(test.elements['[data-poll-feedback]'].classList.contains('open-preview-warning')).toBe(false);
    release({ ...test.state, wallet: OTHER }); await flush();
    expect(test.elements['[data-wallet-label]'].textContent).toBe(WALLET);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls).toEqual([]);
  });

  it('keeps reload guidance on the entry page, which has no Check progress control', async () => {
    let failing = true;
    const test = setup({ entry: true, api: path => path === '/api/session' && failing ? new Promise(() => {}) : undefined }); await flush();
    await tick(test, 8000); await flush();
    expect(test.elements['[data-check-progress]']).toBeUndefined();
    expect(test.elements['[data-request-feedback]'].textContent).toContain('reload this page to check now');
    expect(test.elements['[data-request-feedback]'].textContent).not.toContain('choose Check progress');
    failing = false; await tick(test, 5000);
    expect(test.elements['[data-request-feedback]'].textContent).toBe('');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it.each(['failed', 'abstained'])('preserves a server-rendered %s assessment diagnostic across boot failure and recovery', async status => {
    let failing = true;
    const test = setup({ api: path => path === '/api/session' && failing ? { error: 'Session temporarily unavailable' } : undefined });
    test.elements['[data-assessment-code]'].dataset.assessmentState = status;
    const copy = assessmentFailureText({ errorCategory: status === 'abstained' ? 'assessment-abstained' : 'assessment-blocked', diagnosticReference: '12345678-1234-4123-8123-123456789abc' });
    test.elements['[data-mint-feedback]'].textContent = copy;
    await flush();
    expect(test.elements['[data-mint-feedback]'].textContent).toBe(copy);
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('Session temporarily unavailable');
    failing = false; await tick(test, 5000);
    expect(test.elements['[data-mint-feedback]'].textContent).toBe(copy);
    expect(test.elements['[data-poll-feedback]'].textContent).toBe('');
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe(status);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it('does not clear newer transaction feedback when session recovery completes', async () => {
    let failing = true;
    const test = setup({ mintState: 'pending', mintHash: HASH, api: path => path === '/api/session' && failing ? { error: 'Session temporarily unavailable' } : undefined }); await flush();
    test.elements['[data-poll-feedback]'].textContent = 'Canonical confirmation is still unavailable.';
    failing = false; await tick(test, 5000);
    expect(test.elements['[data-poll-feedback]'].textContent).toBe('Canonical confirmation is still unavailable.');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it.each(['fetch', 'body'])('bounds a hung assessment %s and ignores its late result after a successful retry', async hang => {
    let first = true, release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const test = setup({ pending: true, walletProved: true, storage: intent(),
      api: path => path === ASSESSMENT_PATH && first && hang === 'fetch' ? pending : undefined,
      response: path => path === ASSESSMENT_PATH && first && hang === 'body' ? { ok: true, json: () => pending } : undefined }); await flush();
    const polling = tick(test, 1500); await flush(); await tick(test, 8000); await polling;
    expect(test.elements['[data-check-progress]'].hidden).toBe(false);
    expect(test.requests.find(request => request.path === ASSESSMENT_PATH)!.init.signal.aborted).toBe(true);
    first = false; await tick(test, 5000);
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('ready');
    release({ ...readyStatus, mint: { state: 'minted' } }); await flush();
    expect(test.navigations).toEqual([]);
    expect(sends(test)).toEqual([]);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });

  it('caps assessment retry delay and gives an explicit read-only recovery action', async () => {
    let failing = true;
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path === ASSESSMENT_PATH && failing ? { error: 'Unavailable' } : undefined }); await flush(); await tick(test, 1500);
    for (const delay of [5000, 10000, 20000, 30000, 30000]) await tick(test, delay);
    expect(test.scheduled.filter(timer => timer.delay === 30000)).toHaveLength(1);
    failing = false; await test.elements['[data-check-progress]'].emit('click');
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('ready');
    expect(test.storage.has(INTENT_KEY)).toBe(false);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls).toEqual([]);
  });

  it('discards a response that arrives after local request expiry', async () => {
    let now = Date.now(), release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const test = setup({ pending: true, walletProved: true, storage: intent(), now: () => now, serverNow: now, expiresAt: now + 2000, api: path => path === ASSESSMENT_PATH ? pending : undefined }); await flush();
    const polling = tick(test, 1500); await flush(); now += 2000; await tick(test, 2000);
    release({ ...readyStatus, requestExpired: false }); await polling;
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('expired');
    expect(sends(test)).toEqual([]);
    expect(test.storage.has(INTENT_KEY)).toBe(false);
  });

  it.each(['session', 'assessment', 'confirmation'])('cancels a pending %s read on pagehide and ignores its late body', async kind => {
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const path = kind === 'session' ? '/api/session' : kind === 'assessment' ? ASSESSMENT_PATH : '/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
    const test = setup({ pending: kind === 'assessment', storage: kind === 'confirmation' ? savedSubmission() : intent(), walletProved: true,
      response: url => url === path ? { ok: true, json: () => pending } : undefined }); await flush();
    const polling = kind === 'session' ? Promise.resolve() : tick(test, kind === 'assessment' ? 1500 : 100); await flush();
    const before = test.elements['[data-assessment-status]'].textContent;
    test.globalEvents.pagehide({}); await flush();
    release(kind === 'session' ? test.state : kind === 'assessment' ? { ...readyStatus, mint: { state: 'minted' } } : { state: 'minted' }); await polling; await flush();
    expect(test.requests.find(request => request.path === path)!.init.signal.aborted).toBe(true);
    expect(test.elements['[data-assessment-status]'].textContent).toBe(before);
    expect(test.scheduled).toEqual([]);
    expect(test.navigations).toEqual([]);
    expect(sends(test)).toEqual([]);
  });

  it('does not restore a stale verified wallet when accounts change during session boot', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const test = setup({ walletProved: true, storage: intent(), api: path => path === '/api/session' ? pending : undefined }); await flush();
    test.walletEvents.accountsChanged([OTHER]); release(test.state); await flush();
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe('wallet-required');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(test)).toEqual([]);
  });
});

describe('submitted mint diagnostics', () => {
  it('detects a wallet actually broadcasting nonce 411 after receiving nonce 1 and never submits a duplicate', async () => {
    let test: ReturnType<typeof setup>;
    let walletPrompt = '', actualNonce = '';
    test = setup({ local: true, walletProved: true, walletRequest: (method, params) => {
      if (method === 'eth_sendTransaction') {
        expect((params as any)[0].nonce).toBe('0x1');
        walletPrompt = test.elements['[data-mint-feedback]'].textContent;
        actualNonce = '0x19b'; // Model the wallet ignoring the caller's explicit nonce.
        return HASH;
      }
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: actualNonce };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(walletPrompt).toContain('Transaction nonce: 1.');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411; chain expects 1');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Correct the local wallet nonce');
    expect(test.elements['[data-poll-feedback]'].textContent).toContain(HASH);
    expect(JSON.parse(test.storage.get(SUBMISSION_KEY)!)).toMatchObject({ hash: HASH, wallet: WALLET, expectedNonce: '0x1' });
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    await test.scheduled.shift()!();
    await test.elements['[data-dev-mint]'].emit('click');
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.filter(r => r.path === '/api/mints/authorize')).toHaveLength(1);
    expect(test.walletCalls.filter(r => r.method.startsWith('wallet_'))).toEqual([]);
    expect(test.navigations).toEqual([]);
  });
  it.each(['pending', 'unminted'])('detects a nonce gap from an old saved hash without an authorization snapshot when status is %s', async state => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411; chain expects 1');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]);
  });
  it('uses the original submitting wallet even if accounts change while the wallet returns its hash', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_sendTransaction') test.walletEvents.accountsChanged([OTHER]);
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x19b' };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(JSON.parse(test.storage.get(SUBMISSION_KEY)!).wallet).toBe(WALLET);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
  });
  it('allows brief propagation and reports a missing transaction after 30 seconds without declaring a revert', async () => {
    let now = Date.now();
    const test = setup({ walletProved: true, now: () => now, walletRequest: method => method === 'eth_getTransactionByHash' ? null : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for it to appear');
    now += 29_999; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('dropped');
    now += 1; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('not currently visible');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('may have been dropped');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('reverted');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.scheduled.length).toBeGreaterThan(0);
  });
  it('preserves elapsed time across refresh and reports a previously seen transaction that disappears', async () => {
    let now = Date.now();
    const test = setup({ walletProved: true, now: () => now }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    now += 30_000;
    const refreshed = setup({ walletProved: true, storage: test.storage, now: () => now, walletRequest: method => method === 'eth_getTransactionByHash' ? null : undefined }); await flush();
    await refreshed.scheduled.shift()!();
    expect(refreshed.elements['[data-mint-feedback]'].textContent).toContain('not currently visible');
    expect(refreshed.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(refreshed)).toEqual([]);
  });
  it('keeps a normally pending transaction distinct from a nonce gap and reveals only after server confirmation', async () => {
    let now = Date.now(), minted = false, mined = false;
    const test = setup({ walletProved: true, now: () => now, api: path => path.startsWith('/api/mints/status/') ? { state: minted ? 'minted' : 'unminted' } : undefined, walletRequest: (method, params) => {
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending' && sends(test).length) return '0x2';
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, blockNumber: mined ? '0xb' : null };
      if (method === 'eth_getTransactionReceipt') return mined ? { ...RECEIPT, status: '0x1' } : null;
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    now += 30_000; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('still pending');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce gap');
    mined = true; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for the server to verify');
    expect(test.navigations).toEqual([]); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    minted = true; await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false); expect(sends(test)).toHaveLength(1);
  });
  it('does not call a gap when earlier transactions fill it in the pending pool', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x2' };
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending') return '0x3';
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for confirmation');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce gap');
  });
  it('reports a changed broadcast nonce even if it currently fits in the pending pool', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission({ expectedNonce: '0x1' }), walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x2' };
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending') return '0x3';
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('broadcast transaction nonce 2; the mint requested 1');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it.each(['chain ID', 'fingerprint', 'RPC changed during reads'])('does not diagnose transaction data from a different network: %s', async variant => {
    let changed = false;
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: (method, params) => {
      if (method === 'eth_chainId' && variant === 'chain ID') return '0x1';
      if (method === 'eth_getBlockByNumber' && (variant === 'fingerprint' || changed)) return { number: (params as any)[0], hash: HASH };
      if (method === 'eth_getTransactionByHash') { changed = true; return { ...PENDING_TRANSACTION, nonce: '0x19b' }; }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('different mint network');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce 411');
    if (variant !== 'RPC changed during reads') expect(test.walletCalls.some(r => r.method === 'eth_getTransactionByHash')).toBe(false);
    expect(test.walletCalls.some(r => r.method.startsWith('wallet_'))).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
  });
  it('recovers from intermittent wallet RPC errors while preserving a known nonce gap and the submission guard', async () => {
    let unavailable = true;
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: method => {
      if (method === 'eth_getTransactionByHash') { if (unavailable) throw new Error('RPC unavailable'); return { ...PENDING_TRANSACTION, nonce: '0x19b' }; }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    unavailable = false; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    unavailable = true; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(sends(test)).toEqual([]);
  });
  it('replaces the ready-to-approve status on resume even when the wallet RPC check fails', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: method => { if (method === 'eth_getTransactionByHash') throw new Error('RPC unavailable'); } });
    test.elements['[data-assessment-status]'].textContent = 'Your signature is ready to mint. Approve the transaction in your wallet to reveal it.';
    await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-assessment-status]'].textContent).toContain('Mint submitted');
    expect(test.elements['[data-assessment-status]'].textContent).not.toContain('Approve');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(test)).toEqual([]);
  });
  it.each(['report', 'status', 'both'])('continues read-only diagnostics if the %s API fails', async failure => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => (failure !== 'status' && path === '/api/mints/report') || (failure !== 'report' && path.startsWith('/api/mints/status/')) ? { error: 'Temporary error' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    await test.scheduled.shift()!(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.requests.filter(r => r.path.startsWith('/api/mints/status/'))).toHaveLength(2);
    if (failure !== 'status') expect(test.requests.filter(r => r.path === '/api/mints/report')).toHaveLength(2);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(sends(test)).toEqual([]);
  });
  it.each([{ hash: BLOCK_HASH }, { from: OTHER }, { to: OTHER }, { nonce: '0x019b' }, { nonce: '411' }, { nonce: 411 }, { nonce: undefined }, { blockNumber: undefined }, { chainId: '0x1' }])('rejects malformed or unrelated broadcast details without releasing the guard %#', async overrides => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b', ...overrides } : method === 'eth_getTransactionReceipt' ? { ...RECEIPT } : undefined }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('details that do not match this mint');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it.each([null, { transactionHash: HASH, status: '0x0' }, { ...RECEIPT, from: OTHER }, { ...RECEIPT, to: OTHER }, { ...RECEIPT, transactionHash: BLOCK_HASH }, { ...RECEIPT, blockNumber: null }, { ...RECEIPT, status: '0x2' }])('never treats a missing, malformed, or unrelated receipt as a revert %#', async receipt => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionReceipt' ? receipt : undefined }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('reverted');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it.each(['transaction still pending', 'different transaction block', 'missing canonical block', 'noncanonical receipt block', 'RPC changed during receipt check'])('keeps the submission guard for an unverified reverted receipt: %s', async variant => {
    let changed = false;
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, blockNumber: variant === 'transaction still pending' ? null : variant === 'different transaction block' ? '0xc' : '0xb' };
      if (method === 'eth_getTransactionReceipt') return { ...RECEIPT };
      if (method === 'eth_getBlockByNumber') {
        if ((params as any)[0] === '0xb') {
          if (variant === 'missing canonical block') return null;
          if (variant === 'noncanonical receipt block') return { number: '0xb', hash: HASH };
          if (variant === 'RPC changed during receipt check') changed = true;
        } else if (changed) return { number: (params as any)[0], hash: HASH };
      }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('transaction reverted');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it('times out a never-settling transaction lookup, continues canonical confirmation, and discards late diagnostics', async () => {
    let resolveLookup!: (value: unknown) => void;
    const lookup = new Promise(resolve => { resolveLookup = resolve; });
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? lookup : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    await test.scheduled.shift()!(); await flush(); await submission; // Eight-second diagnostic deadline.
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toHaveLength(1);
    resolveLookup({ ...PENDING_TRANSACTION, nonce: '0x19b' }); await flush();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce 411');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
  });
  it('times out hanging report requests without blocking nonce diagnosis or canonical confirmation', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/report' ? new Promise(() => {}) : path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    await test.scheduled.shift()!(); await flush(); await submission;
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.scheduled.shift()!(); await flush();
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toHaveLength(1);
  });
  it('times out a hanging status read, inspects the existing transaction, and confirms on a later poll', async () => {
    let first = true;
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => {
      if (path.startsWith('/api/mints/status/')) { if (first) { first = false; return new Promise(() => {}); } return { state: 'minted' }; }
    }, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    const polling = test.scheduled.shift()!(); await flush();
    await test.scheduled.shift()!(); await flush(); await polling;
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toEqual([]);
  });
});

describe('preview and mint browser lifecycle', () => {
  it('restores the handle draft on entry reload without restoring wallet or mint consent', async () => {
    const storage = new Map<string, string>();
    const first = setup({ entry: true, initialHandle: '', storage });
    await flush();
    const input = first.elements['[data-assessment-request]'].children['input[name=handle]'];
    input.value = '@Alice_Bob_Key'; await input.emit('input');
    const refreshed = setup({ entry: true, initialHandle: '', storage });
    await flush();
    expect(refreshed.elements['[data-assessment-request]'].children['input[name=handle]'].value).toBe('@Alice_Bob_Key');
    expect(refreshed.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(true);
    expect(refreshed.requests.some(r => r.path === '/api/assessments')).toBe(false);
    expect(refreshed.walletCalls.some(r => ['personal_sign', 'eth_sendTransaction'].includes(r.method))).toBe(false);
  });
  it('performs no requests on preview and never assesses on a plain mint page load', async () => {
    const preview = setup({ preview: true }); preview.rerun(); await flush();
    expect(preview.requests).toEqual([]); expect(preview.walletCalls).toEqual([]);
    const entry = setup({ entry: true }); await flush();
    expect(entry.requests.map(r => r.path)).toEqual(['/api/session']); expect(entry.walletCalls).toEqual([]);
  });
  it('blocks assessment without verified wallet, including programmatic form submission', async () => {
    const test = setup({ entry: true }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
    expect(test.elements['[data-request-feedback]'].textContent).toContain('Connect and verify');
  });
  it('connects a general wallet without assessment, transaction, or navigation', async () => {
    const test = setup({ entry: true }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.find(r => r.path === '/api/wallet/challenge')?.body).toEqual({ address: WALLET });
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
    expect(test.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(false);
    expect(sends(test)).toEqual([]); expect(test.navigations).toEqual([]);
  });
  it.each(['connect', 'assess', 'mint'])('blocks %s on another Anvil node with the same chain ID', async action => {
    const test = setup({ local: true, entry: action !== 'mint', walletProved: action !== 'connect', walletRequest: method => method === 'eth_getBlockByNumber' ? { number: NETWORK.blockNumber, hash: HASH } : undefined }); await flush();
    await test.elements[action === 'connect' ? '[data-connect-wallet]' : action === 'assess' ? '[data-assessment-request]' : '[data-mint-form]'].emit(action === 'connect' ? 'click' : 'submit');
    expect(test.requests.some(r => ['/api/assessments', '/api/mints/authorize', '/api/wallet/challenge'].includes(r.path))).toBe(false);
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(sends(test)).toEqual([]);
    expect(test.elements[action === 'assess' ? '[data-request-feedback]' : '[data-mint-feedback]'].textContent).toContain('Set its RPC to http://127.0.0.1:8545');
  });
  it.each(['connect', 'assess', 'mint'].flatMap(action => [undefined, 4902].map(code => ({ action, code }))))('gives configured local RPC guidance before $action when the same-chain proof read rejects with $code', async ({ action, code }) => {
    const test = setup({ local: true, entry: action !== 'mint', walletProved: action !== 'connect', walletRequest: method => {
      if (method === 'eth_getBlockByNumber') throw Object.assign(new Error('viem transport failed at http://127.0.0.1:18549/private-token'), { code });
    } }); await flush();
    test.state.rpcUrl = 'http://127.0.0.1:18560';
    await test.elements[action === 'connect' ? '[data-connect-wallet]' : action === 'assess' ? '[data-assessment-request]' : '[data-mint-form]'].emit(action === 'connect' ? 'click' : 'submit');
    const copy = test.elements[action === 'assess' ? '[data-request-feedback]' : '[data-mint-feedback]'].textContent;
    expect(copy).toContain('Cannot verify your wallet RPC');
    expect(copy).toContain('Configured local RPC: http://127.0.0.1:18560/');
    expect(copy).toContain('Check the configured network/RPC in your wallet, then reconnect');
    expect(copy.match(/reconnect/g)).toHaveLength(1);
    expect(copy).not.toMatch(/18549|private-token|viem|different.*chain/);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls.filter(call => call.method === 'eth_getBlockByNumber')).toHaveLength(1);
    expect(test.walletCalls.filter(call => ['personal_sign', 'eth_sendTransaction', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'].includes(call.method))).toEqual([]);
    expect(test.scheduled).toEqual([]);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
  });
  it.each([4001, 'ACTION_REJECTED'])('preserves wallet rejection %s during a network proof read', async code => {
    const test = setup({ local: true, entry: true, walletRequest: method => { if (method === 'eth_getBlockByNumber') throw Object.assign(new Error('Rejected'), { code }); } }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Cancelled in your wallet');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('Cannot verify');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(test.walletCalls.filter(call => ['personal_sign', 'eth_sendTransaction', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'].includes(call.method))).toEqual([]);
  });
  it.each(['https://localhost:18560', 'http://[::1]:18560'])('allows only a configured loopback endpoint in local proof-read guidance: %s', async rpcUrl => {
    const test = setup({ local: true, walletProved: true, walletRequest: method => { if (method === 'eth_getBlockByNumber') throw new Error('Raw transport details'); } }); await flush(); test.state.rpcUrl = rpcUrl;
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Configured local RPC: ' + new URL(rpcUrl).href);
    expect(sends(test)).toEqual([]);
  });
  it.each(['http://localhost.evil.test:18560', 'https://rpc.example.test/private-token', 'http://user:secret@127.0.0.1:18560', 'http://127.0.0.1:18560?token=secret', 'http://127.0.0.1:18560#secret', 'ftp://localhost:18560', 'not-a-url'])('omits unsafe configured RPC details from proof-read guidance: %s', async rpcUrl => {
    const test = setup({ local: true, walletProved: true, walletRequest: method => { if (method === 'eth_getBlockByNumber') throw new Error('Raw transport details http://private.example/token'); } }); await flush(); test.state.rpcUrl = rpcUrl;
    await test.elements['[data-mint-form]'].emit('submit');
    const copy = test.elements['[data-mint-feedback]'].textContent;
    expect(copy).toContain('Cannot verify your wallet RPC');
    expect(copy).not.toContain(rpcUrl);
    expect(copy).not.toMatch(/Configured local RPC|private|secret|Raw transport/);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
  });
  it('keeps loopback RPC guidance out of non-local deployments', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_getBlockByNumber') throw new Error('Connection refused'); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Cannot verify your wallet RPC');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toMatch(/127\.0\.0\.1|Configured local RPC/);
  });
  it('also contains a transport error from the proof chain recheck', async () => {
    let chainReads = 0;
    const test = setup({ local: true, walletProved: true, walletRequest: method => { if (method === 'eth_chainId' && ++chainReads === 3) throw new Error('Raw recheck error'); } }); await flush(); test.state.rpcUrl = 'http://127.0.0.1:18560';
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Configured local RPC: http://127.0.0.1:18560/');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('Raw recheck');
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });
  it.each(['wallet-change', 'pagehide'])('does not give stale endpoint advice after %s during a failed proof read', async event => {
    let reject!: (error: unknown) => void;
    const read = new Promise((_, no) => { reject = no; });
    const test = setup({ local: true, walletProved: true, walletRequest: method => method === 'eth_getBlockByNumber' ? read : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    if (event === 'wallet-change') test.walletEvents.chainChanged('0x1'); else test.globalEvents.pagehide({});
    const before = test.elements['[data-mint-feedback]'].textContent;
    reject(new Error('Raw stale read')); await submission;
    if (event === 'wallet-change') expect(test.elements['[data-mint-feedback]'].textContent).toContain('wallet changed during the network check');
    else expect(test.elements['[data-mint-feedback]'].textContent).toBe(before);
    expect(test.elements['[data-mint-feedback]'].textContent).not.toMatch(/Raw stale|Configured local RPC|different.*chain/);
    expect(test.elements['[data-mint-network]'].hidden).toBe(true);
    expect(test.requests.filter(request => request.init.method === 'POST')).toEqual([]);
    expect(sends(test)).toEqual([]);
  });
  it('keeps a submitted transaction guarded and shows local guidance when its network proof is unavailable', async () => {
    const test = setup({ local: true, walletProved: true, storage: savedSubmission(), walletRequest: method => { if (method === 'eth_getBlockByNumber') throw new Error('Raw unavailable RPC'); } }); await flush(); test.state.rpcUrl = 'http://127.0.0.1:18560'; await tick(test, 100);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Configured local RPC: http://127.0.0.1:18560/');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Do not submit another mint');
    expect(test.elements['[data-mint-transaction]'].textContent).toContain(HASH);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.requests.some(request => request.path === '/api/mints/authorize')).toBe(false);
    expect(test.walletCalls.filter(call => ['personal_sign', 'eth_sendTransaction', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'].includes(call.method))).toEqual([]);
  });
  it('preserves the existing explicit-connect unknown-chain 4902 add flow', async () => {
    let chain = '0x1', added = false;
    const test = setup({ local: true, entry: true, walletRequest: method => {
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { if (!added) throw Object.assign(new Error('Unknown chain'), { code: 4902 }); chain = '0x7a69'; return null; }
      if (method === 'wallet_addEthereumChain') { added = true; return null; }
    } }); await flush(); test.state.rpcUrl = 'http://127.0.0.1:18560';
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.filter(call => call.method === 'wallet_addEthereumChain')).toHaveLength(1);
    expect(test.walletCalls.find(call => call.method === 'wallet_addEthereumChain')?.params).toMatchObject([{ chainId: '0x7a69', rpcUrls: ['http://127.0.0.1:18560/'] }]);
    expect(test.requests.some(request => request.path === '/api/wallet/challenge')).toBe(true);
    expect(test.requests.some(request => request.path === '/api/assessments')).toBe(false);
    expect(sends(test)).toEqual([]);
  });
  it.each([null, { number: '0x9', hash: BLOCK_HASH }])('fails closed when the wallet cannot confirm the trusted block %#', async block => {
    const test = setup({ walletProved: true, walletRequest: method => method === 'eth_getBlockByNumber' ? block : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(false);
  });
  it.each([{}, { ...NETWORK, contract: OTHER }, { ...NETWORK, chainId: '0x1' }, { ...NETWORK, blockNumber: '0x01' }, { ...NETWORK, blockHash: '0x1234' }])('requires a complete trusted network context before signing %#', async network => {
    const test = setup({ entry: true, api: path => path === '/api/wallet/context' ? network : undefined }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
  });
  it('checks a fresh network context after the sign-in challenge and before personal_sign', async () => {
    let contexts = 0;
    const test = setup({ entry: true, api: path => path === '/api/wallet/context' ? { ...NETWORK, blockHash: ++contexts === 1 ? BLOCK_HASH : HASH } : undefined }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.some(r => r.path === '/api/wallet/challenge')).toBe(true);
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(test.requests.filter(r => r.path === '/api/wallet/context').every(r => r.init.cache === 'no-store')).toBe(true);
  });
  it('blocks account-change events during the wallet challenge even if the address changes back', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ entry: true, api: path => { if (path === '/api/wallet/challenge') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); } } }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(test.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(true);
  });
  it('passes the verified canonical nonce explicitly when the wallet honors it', async () => {
    let broadcastNonce = '0x19a';
    const test = setup({ walletProved: true, walletRequest: (method, params) => { if (method === 'eth_sendTransaction') broadcastNonce = (params as any)[0].nonce ?? broadcastNonce; } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(broadcastNonce).toBe('0x1');
    expect((sends(test)[0].params as any)[0]).toMatchObject({ from: WALLET, to: CONTRACT, nonce: '0x1', value: '0x0' });
    expect(test.requests.some(r => r.path === '/api/wallet/context?address=' + WALLET)).toBe(true);
    expect(test.walletCalls.find(r => r.method === 'eth_getTransactionCount')?.params).toEqual([WALLET, 'pending']);
    expect(test.walletCalls.find(r => r.method === 'eth_call')?.params).toEqual([{ from: WALLET, to: CONTRACT, data: '0x1234', value: '0x0' }, 'latest']);
  });
  it.each(['0x19a', '0x2'])('blocks wallet-reported nonce %s when the authorized nonce is 1', async nonce => {
    const test = setup({ walletProved: true, walletRequest: method => method === 'eth_getTransactionCount' ? nonce : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
  });
  it.each([undefined, null, 1, '1', '0x01', '0xA', '0x-1', '0x20000000000000'])('requires canonical safe nonnegative transaction nonce %#', async nonce => {
    const test = setup({ walletProved: true, authorize: { transaction: { from: WALLET, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x0', nonce } } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce is invalid');
  });
  it.each([undefined, {}, { ...NETWORK }, { ...NETWORK, nonce: '0x2' }, { ...NETWORK, nonce: '0x1', blockHash: HASH }])('requires matching authorization network proof %#', async network => {
    const test = setup({ walletProved: true, authorize: { network } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it.each([{ ...NETWORK, nonce: '0x2' }, { ...NETWORK }, { ...NETWORK, nonce: '0x1', blockHash: HASH }])('blocks a changed or incomplete fresh pre-send context %#', async network => {
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/wallet/context?') ? network : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it('blocks wallet RPC changes after authorization, even without a chainChanged event', async () => {
    let changed = false;
    const test = setup({ walletProved: true, duringAuthorize: () => { changed = true; }, walletRequest: (method, params) => method === 'eth_getBlockByNumber' && changed ? { number: (params as any)[0], hash: HASH } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(true);
  });
  it('never broadcasts if the exact transaction simulation fails', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_call') throw new Error('Execution reverted'); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-mint-feedback]'].textContent).toBe('Warning Execution reverted');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('detects a same-chain RPC swap during the simulation before submitting', async () => {
    let changed = false;
    const test = setup({ walletProved: true, walletRequest: (method, params) => {
      if (method === 'eth_call') changed = true;
      if (method === 'eth_getBlockByNumber' && changed) return { number: (params as any)[0], hash: HASH };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it('rechecks the provider nonce after simulation and blocks a concurrently consumed nonce', async () => {
    let simulated = false;
    const test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_call') simulated = true;
      if (method === 'eth_getTransactionCount') return simulated ? '0x2' : '0x1';
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]);
    expect(test.walletCalls.filter(r => r.method === 'eth_getTransactionCount')).toHaveLength(2);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('rechecks the backend nonce after simulation before sending', async () => {
    let contexts = 0;
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/wallet/context?') ? { ...NETWORK, nonce: ++contexts === 1 ? '0x1' : '0x2' } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(contexts).toBe(2);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
  });
  it('rechecks account-change generations after all RPC awaits', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_call') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); }
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it('sends only case-preserved handle under CSRF and stores a wallet-bound intent', async () => {
    const test = setup({ entry: true, walletProved: true }); await flush();
    test.elements['[data-assessment-request]'].children['input[name=handle]'].value = ' @Alice_Bob_Key ';
    await test.elements['[data-assessment-request]'].emit('submit');
    const request = test.requests.find(r => r.path === '/api/assessments')!;
    expect(request.body).toEqual({ handle: 'Alice_Bob_Key' });
    expect(request.init.credentials).toBe('same-origin'); expect(request.init.headers['X-CSRF-Token']).toBe('csrf');
    expect(test.navigations).toEqual(['/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr']);
    expect(JSON.parse(test.storage.get('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')!)).toMatchObject({ handle: 'alice_bob_key', wallet: WALLET, tokenId: '123', mode: 'injected' });
    expect(sends(test)).toEqual([]);
  });
  it.each(['/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr/extra', '/p/agent_art/ENFP', 'https://attacker.test/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr?mbti=INTJ', '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr#mint'])('rejects malformed result URL %s', async url => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { url, code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'agent_art', tokenId: '123' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.navigations).toEqual([]); expect(test.elements['[data-request-feedback]'].textContent).toContain('invalid result link');
  });
  it('does not accept another handle in the prepare response', async () => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { url: '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'other', tokenId: '123' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.navigations).toEqual([]);
  });
  it('navigates an already-minted handle only to its exact same-origin permalink', async () => {
    for (const url of ['/signatures/agent_art', 'https://attacker.test/signatures/agent_art']) {
      const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { error: 'Minted', code: 'ALREADY_MINTED', url } : undefined }); await flush();
      await test.elements['[data-assessment-request]'].emit('submit');
      expect(test.navigations).toEqual(url.startsWith('/') ? [url] : []);
    }
  });
  it('continues an explicit one-shot intent after assessment, without a second art confirmation', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent() }); await flush();
    expect(sends(test)).toEqual([]); expect(test.scheduled.filter(timer => timer.delay === 1500)).toHaveLength(1);
    await test.scheduled.shift()!();
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.find(r => r.path === '/api/mints/authorize')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', consent: true });
    expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.navigations).toEqual([]);
    expect(test.requests.every(r => !r.path.startsWith('/artifacts/'))).toBe(true);
  });
  it('does not auto-prompt for a ready result without a prior explicit intent', async () => {
    const test = setup({ walletProved: true }); await flush();
    expect(sends(test)).toEqual([]); expect(test.walletCalls).toEqual([]);
    expect(test.elements['[data-assessment-code]'].dataset.progressRecovery).toBe('true');
    await test.elements['[data-mint-form]'].emit('submit'); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it.each([{ expiresAt: 0 }, { wallet: OTHER }, { tokenId: '999' }, { handle: 'other' }, { contract: OTHER }, { chain: '0x1' }, { mode: 'local' }])('discards stale or mismatched resume intent %#', async value => {
    const test = setup({ walletProved: true, storage: intent(undefined, value) }); await flush();
    expect(sends(test)).toEqual([]); expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('waits for an explicit continuation after wallet cancellation and reuses preparation', async () => {
    let cancel = true;
    const test = setup({ walletProved: true, storage: intent(), walletRequest: method => { if (method === 'eth_sendTransaction' && cancel) throw Object.assign(new Error('User rejected'), { code: 4001 }); } }); await flush();
    expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false); expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Cancelled');
    expect(test.elements['[data-assessment-code]'].dataset.progressRecovery).toBe('true');
    cancel = false; await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(2); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it('persists unknown submission outcomes and never blindly resubmits on refresh', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_sendTransaction') throw new Error('Connection lost'); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(test.elements['[data-mint-feedback]'].textContent).toContain('uncertain');
    const refreshed = setup({ walletProved: true, storage: test.storage }); await flush();
    await refreshed.elements['[data-mint-form]'].emit('submit'); expect(sends(refreshed)).toEqual([]);
  });
  it('persists a submitted hash and retries failed reporting after refresh, revealing only on minted state', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/report' ? { error: 'Temporary failure' } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.navigations).toEqual([]); expect(test.storage.get('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toContain(HASH);
    let confirmed = false;
    const refreshed = setup({ walletProved: true, storage: test.storage, api: path => path === '/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { state: confirmed ? 'minted' : 'pending' } : undefined }); await flush();
    await refreshed.scheduled.shift()!();
    expect(refreshed.requests.find(r => r.path === '/api/mints/report')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', transactionHash: HASH });
    expect(refreshed.navigations).toEqual([]);
    confirmed = true; await refreshed.scheduled.shift()!();
    expect(refreshed.navigations).toEqual(['/signatures/agent_art']); expect(sends(refreshed)).toEqual([]);
  });
  it('permits explicit continuation after a matching reverted receipt without reassessment', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionReceipt' ? { ...RECEIPT } : method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, blockNumber: RECEIPT.blockNumber } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('reverted'); expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it.each([
    { code: 'other' }, { handle: 'someone_else' }, { tokenId: '999' }, { expiresAt: '2000-01-01T00:00:00Z' },
    { transaction: { from: OTHER, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: OTHER, chainId: '31337', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: CONTRACT, chainId: '1', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x1' } },
  ])('blocks mismatched or expired authorization %#', async authorize => {
    const test = setup({ walletProved: true, authorize }); await flush(); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toMatch(/different work|expired|does not match/);
  });
  it('blocks account changes during authorization and disables controls', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, duringAuthorize: () => test.walletEvents.accountsChanged([OTHER]) }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it('does not assess if the injected wallet differs from the signed session', async () => {
    const test = setup({ entry: true, walletProved: true, accounts: () => [OTHER] }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it.each(['failed', 'abstained'])('stops on %s assessment without requesting a wallet transaction', async status => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path === '/api/assessments/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { handle: 'agent_art', tokenId: '123', status, error: 'No usable public content.' } : undefined }); await flush();
    await test.scheduled.shift()!(); expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toContain('No usable public content');
    expect(test.elements['[data-assessment-code]'].dataset.mintUiPhase).toBe(status);
    expect(test.storage.has(INTENT_KEY)).toBe(false);
  });
  it('connects local DEV wallet without minting and follows only explicit local intent', async () => {
    const entry = setup({ entry: true, local: true }); await flush();
    await entry.elements['[data-dev-wallet]'].emit('click'); expect(entry.navigations).toEqual([]);
    expect(entry.elements['[data-dev-wallet]'].disabled).toBe(false);
    expect(entry.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(false);
    expect(entry.requests.some(r => r.path === '/api/dev/mint' || r.path === '/api/assessments')).toBe(false);
    await entry.elements['[data-assessment-request]'].emit('submit');
    const result = setup({ local: true, walletProved: true, storage: entry.storage }); await flush();
    expect(result.requests.find(r => r.path === '/api/dev/mint')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', consent: true });
    expect(result.walletCalls).toEqual([]); expect(result.navigations).toEqual([]);
  });
  it('does not loop on legacy minted markup with an empty request code', async () => {
    const test = setup({ preview: true });
    const article = new Element(); article.dataset = { assessmentCode: '', assessmentHandle: 'agent_art', mintState: 'minted' };
    test.elements['[data-assessment-code]'] = article;
    // A separate execution represents a document with empty-code public markup.
    const scriptWindow: Record<string, unknown> = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    runInNewContext(OPEN_MINT_CLIENT_SCRIPT, { window: scriptWindow, document: { querySelector: (key: string) => test.elements[key] ?? null, querySelectorAll: () => [] }, Event, AbortController, Date, URL, location: { assign: (url: string) => test.navigations.push(url) }, fetch: () => { throw new Error('Public minted page must not poll.'); } });
    await flush(); expect(test.navigations).toEqual([]); expect(test.requests).toEqual([]);
  });
  it('cancels paid preparation on an account-change event during eth_accounts, even if the account changes back', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ entry: true, walletProved: true, walletRequest: method => {
      if (method === 'eth_accounts') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); return [WALLET]; }
    } }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it('does not auto-mint when wallet proof expires while an assessment runs', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path.startsWith('/api/assessments/') ? { handle: 'agent_art', tokenId: '123', status: 'ready', canMint: true, walletProvedForCode: false } : undefined }); await flush();
    await test.scheduled.shift()!(); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-assessment-status]'].textContent).toBe('Connect your wallet to continue');
  });
  it('waits for confirmation without authorization if the handle is already confirming', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path.startsWith('/api/assessments/') ? { handle: 'agent_art', tokenId: '123', status: 'ready', canMint: false, mint: { state: 'pending' } } : undefined }); await flush();
    await test.scheduled.shift()!();
    expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(false);
    expect(test.elements['[data-assessment-status]'].textContent).toContain('Waiting to reveal');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it.each(['WALLET_PROOF_REQUIRED', 'MINT_NETWORK_UNAVAILABLE'])('keeps local pre-broadcast rejection %s retryable instead of marking an unknown transaction', async code => {
    const test = setup({ local: true, api: path => path === '/api/dev/mint' ? { error: 'Network or wallet unavailable', code } : undefined }); await flush();
    await test.elements['[data-dev-wallet]'].emit('click'); await test.elements['[data-dev-mint]'].emit('click');
    expect([...test.storage.keys()].some(key => key.includes('submission:'))).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain(code === 'WALLET_PROOF_REQUIRED' ? 'Connect and verify' : 'Network or wallet unavailable');
    expect(test.elements['[data-dev-mint]'].disabled).toBe(code === 'WALLET_PROOF_REQUIRED');
    expect(test.walletCalls).toEqual([]);
  });
  it('blocks an invalid handle before wallet or assessment work even on programmatic submit', async () => {
    const test = setup({ entry: true, walletProved: true }); await flush();
    const field = test.elements['[data-assessment-request]'].children['input[name=handle]'];
    Object.assign(field, { value: '', checkValidity: () => false });
    const requests = test.requests.length, walletCalls = test.walletCalls.length;
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.requests).toHaveLength(requests);
    expect(test.walletCalls).toHaveLength(walletCalls);
    expect(test.navigations).toEqual([]);
  });
  it('keeps raw server errors meaningful and disposes polling/listeners on navigation', async () => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { error: 'Generation is not configured.', code: 'GROK_NOT_CONFIGURED' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.elements['[data-request-feedback]'].textContent).toBe('Warning Generation is not configured.');
    const pending = setup({ pending: true }); await flush(); const poll = pending.scheduled[0]; pending.globalEvents.pagehide({});
    expect(pending.scheduled).toEqual([]);
    await poll(); expect(pending.walletEvents).toEqual({}); expect(pending.requests).toHaveLength(1);
  });
});
