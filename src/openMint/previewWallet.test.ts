import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  aboutPage, collectionPage, explorePage, homePage, mbtiGalleryPage,
  mintPage, previewPage, previewVariationsPage, type OpenMintPageOptions,
} from "./pages.js";
import { MBTI_TYPES } from "./identity.js";
import { bindPreviewWalletNotice, walletShortcut } from "./previewWallet.js";
import { OPEN_MINT_CLIENT_SCRIPT } from "./clientScript.js";

type Listener = (event: { type: string; key?: string; target?: unknown; preventDefault(): void }) => void;

function fixture({ noticePresent = true, summaryPresent = true } = {}) {
  const documentListeners = new Map<string, Listener[]>();
  const noticeListeners = new Map<string, Listener[]>();
  const summary = { focus: vi.fn() };
  const interior = {};
  const exterior = {};
  const notice = {
    open: false,
    dataset: {} as Record<string, string>,
    querySelector: vi.fn((selector: string) => selector.includes("summary") && summaryPresent ? summary : null),
    contains: vi.fn((target: unknown) => target === summary || target === interior || target === notice),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      noticeListeners.set(type, [...noticeListeners.get(type) ?? [], listener]);
    }),
  };
  const nodes = new Map<string, unknown>();
  if (noticePresent) nodes.set("[data-preview-wallet-notice]", notice);
  const doc = {
    querySelector: vi.fn((selector: string) => nodes.get(selector) ?? null),
    querySelectorAll: vi.fn((selector: string) => nodes.has(selector) ? [nodes.get(selector)] : []),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      documentListeners.set(type, [...documentListeners.get(type) ?? [], listener]);
    }),
  };
  const emit = (type: string, target: unknown = exterior, key?: string) => {
    const event = { type, target, key, preventDefault: vi.fn() };
    if (target === summary || target === interior || target === notice) {
      for (const listener of noticeListeners.get(type) ?? []) listener(event);
    }
    for (const listener of documentListeners.get(type) ?? []) listener(event);
    return event;
  };
  return {
    doc: doc as unknown as Document, nodes, notice, summary, interior, exterior,
    documentListeners, noticeListeners, emit,
    bind: () => bindPreviewWalletNotice(doc as unknown as Document),
  };
}

const pages: Array<[string, (options: OpenMintPageOptions) => string]> = [
  ["home", options => homePage(options)],
  ["about", options => aboutPage(options)],
  ["explore", options => explorePage("Alice_Bob", options)],
  ["mint", options => mintPage("Alice_Bob", options)],
  ["preview", options => previewPage("Alice_Bob", "INTJ", options)],
  ["variations", options => previewVariationsPage("Alice_Bob", options)],
  ["collection", options => collectionPage([], options)],
  ["MBTI gallery", options => mbtiGalleryPage("INTJ", [], options)],
];
const wallet = "0x170AF4D923De5E3155067e104134C3b11d82E100";
const noticeOf = (html: string) => html.match(/<details\b[^>]*data-preview-wallet-notice[^>]*>[\s\S]*?<\/details>/)?.[0];

describe("prelaunch wallet shortcut", () => {
  it("uses a native keyboard-operable disclosure with an honest explanation and preview invitation", () => {
    const html = walletShortcut(true);
    expect(noticeOf(html)).toBe(html);
    expect(html).toContain('class="preview-wallet-menu"');
    expect(html).toMatch(/<summary\b[^>]*class="collection-shortcut"[^>]*aria-label="Wallet information"/);
    expect(html).toContain('title="Wallet information"');
    expect(html).toContain('aria-controls="preview-wallet-notice"');
    expect(html).toContain('class="collection-shortcut-dot" aria-hidden="true"');
    expect(html).toContain('id="preview-wallet-notice"');
    expect(html).toContain('class="preview-wallet-panel"');
    expect(html).toContain('aria-labelledby="preview-wallet-title"');
    expect(html).toMatch(/<h2\b[^>]*id="preview-wallet-title"[^>]*>Wallet<\/h2>/);
    expect(html).toMatch(/Wallet connection (?:isn’t|is not) needed yet\./);
    expect(html).toMatch(/Minting (?:hasn’t opened|is not open)\./);
    expect(html).toContain('href="/explore"');
    expect(html).toContain("Explore previews");
    expect(html).not.toMatch(/data-connect-wallet|data-disconnect-wallet|data-wallet-label|\/me|personal_sign|eth_requestAccounts|<script/);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/);
  });

  it("retains the collection destination outside prelaunch", () => {
    const html = walletShortcut(false);
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain('aria-label="My Collection"');
    expect(html).toContain('title="My Collection"');
    expect(html).not.toContain("data-preview-wallet-notice");
    expect(html).not.toContain("Wallet connection");
  });

  it.each(pages)("%s has exactly one shared notice for either explicit prelaunch signal, with no connected-address leak", (_name, page) => {
    for (const paused of [false, true]) {
      for (const options of [
        { siteLaunchMode: "prelaunch" as const },
        { pulseSaleStatus: { phase: "prelaunch" as const, paused } },
        { siteLaunchMode: "prelaunch" as const, pulseSaleStatus: { phase: "paid" as const, paused } },
      ]) {
        const html = page({ ...options, pulseMint: true, wallet, walletVerified: true });
        const notice = noticeOf(html);
        expect(notice).toBe(walletShortcut(true));
        expect(html.match(/data-preview-wallet-notice/g)).toHaveLength(1);
        expect(html.match(/id="preview-wallet-notice"/g)).toHaveLength(1);
        expect(html.match(/id="preview-wallet-title"/g)).toHaveLength(1);
        expect(notice).not.toContain(wallet);
        expect(notice).not.toMatch(/data-connect-wallet|data-disconnect-wallet|data-wallet-label|personal_sign|eth_requestAccounts|\/me/);
        expect(html).not.toContain('class="collection-shortcut" href="/me"');
      }
    }
  });

  it.each(pages)("%s keeps normal collection navigation in free, paid and unknown phases, including pauses", (_name, page) => {
    for (const phase of ["free", "paid", "unknown"] as const) for (const paused of [false, true]) {
      const html = page({ siteLaunchMode: "open", pulseMint: true, pulseSaleStatus: { phase, paused } });
      expect(html).toContain(walletShortcut(false));
      expect(html).not.toContain("data-preview-wallet-notice");
    }
    expect(page({})).toContain(walletShortcut(false));
  });

  it.each(MBTI_TYPES)("the %s gallery shares the same no-connection prelaunch notice", mbti => {
    const html = mbtiGalleryPage(mbti, [], { pulseMint: true, siteLaunchMode: "prelaunch" });
    expect(noticeOf(html)).toBe(walletShortcut(true));
  });
});

describe("generated generic client preview wallet notice", () => {
  it.each(["home", "about", "preview", "variations", "collection", "MBTI gallery"])("%s binds the dot without bootstrapping providers or sessions", page => {
    const view = fixture();
    view.nodes.set("[data-open-mint]", { dataset: {} });
    if (page === "about") view.nodes.set("[data-about-reading]", {});
    const forbidden = vi.fn(() => { throw new Error("An informational preview must not access wallet or saved mint state"); });
    const host: Record<PropertyKey, unknown> = {};
    const window = new Proxy(host, {
      get(target, key) { return key === "__openMintBound" ? target[key] : forbidden(); },
      set(target, key, value) { if (key !== "__openMintBound") forbidden(); target[key] = value; return true; },
    });
    expect(() => runInNewContext(OPEN_MINT_CLIENT_SCRIPT, {
      document: view.doc, window, navigator: {}, fetch: forbidden,
      localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
    })).not.toThrow();
    expect(view.notice.dataset.previewWalletBound).toBe("true");
    expect(view.notice.open).toBe(false);
    view.notice.open = true;
    view.emit("keydown", view.interior, "Escape");
    expect(view.notice.open).toBe(false);
    expect(view.summary.focus).toHaveBeenCalledOnce();
    view.notice.open = true;
    view.emit("pointerdown", view.exterior);
    expect(view.notice.open).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("the prelaunch input restores only the handle draft, never an existing wallet or mint submission", () => {
    const view = fixture();
    const input = { value: "", defaultValue: "" };
    view.nodes.set("[data-open-mint]", { dataset: {} });
    view.nodes.set('input[name="handle"]', input);
    const operations: Array<[string, string]> = [];
    const forbidden = vi.fn(() => { throw new Error("Preview cannot bootstrap wallet or mint recovery"); });
    const host: Record<PropertyKey, unknown> = {};
    runInNewContext(OPEN_MINT_CLIENT_SCRIPT, {
      document: view.doc,
      window: new Proxy(host, {
        get(target, key) { return key === "__openMintBound" ? target[key] : forbidden(); },
        set(target, key, value) { if (key !== "__openMintBound") forbidden(); target[key] = value; return true; },
      }),
      navigator: {}, fetch: forbidden, localStorage: new Proxy({}, { get: forbidden }),
      sessionStorage: {
        getItem(key: string) { operations.push(["get", key]); return JSON.stringify({ version: 1, source: "", value: "@Alice_Bob" }); },
        setItem(key: string) { operations.push(["set", key]); },
        removeItem: forbidden,
      },
    });
    expect(input.value).toBe("@Alice_Bob");
    expect(operations).toEqual([["get", "sg-open:mint-handle-draft:v1"], ["set", "sg-open:mint-handle-draft:v1"]]);
    view.notice.open = true;
    view.emit("pointerdown", view.exterior);
    expect(view.notice.open).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe("prelaunch wallet notice dismissal", () => {
  it("binds once without opening the disclosure or moving focus", () => {
    const view = fixture();
    view.bind();
    const listenerCount = view.doc.addEventListener;
    const documentRegistrationCount = (listenerCount as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const noticeRegistrationCount = view.notice.addEventListener.mock.calls.length;
    view.bind();
    expect(view.notice.dataset.previewWalletBound).toBe("true");
    expect(view.notice.open).toBe(false);
    expect(view.summary.focus).not.toHaveBeenCalled();
    expect((listenerCount as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(documentRegistrationCount);
    expect(view.notice.addEventListener.mock.calls).toHaveLength(noticeRegistrationCount);
  });

  it("Escape closes an open notice and restores focus to the dot", () => {
    const view = fixture();
    view.bind();
    view.notice.open = true;
    view.emit("keydown", view.interior, "Escape");
    expect(view.notice.open).toBe(false);
    expect(view.summary.focus).toHaveBeenCalledOnce();
  });

  it("ignores ordinary keys and does not take focus when Escape is pressed while closed", () => {
    const view = fixture();
    view.bind();
    view.emit("keydown", view.exterior, "Escape");
    expect(view.summary.focus).not.toHaveBeenCalled();
    view.notice.open = true;
    for (const key of ["Enter", " ", "Tab", "Esc", "a"]) view.emit("keydown", view.interior, key);
    expect(view.notice.open).toBe(true);
    expect(view.summary.focus).not.toHaveBeenCalled();
  });

  it("keeps inside interaction open and closes on an outside pointer without stealing focus", () => {
    const view = fixture();
    view.bind();
    view.notice.open = true;
    for (const target of [view.summary, view.interior, view.notice]) view.emit("pointerdown", target);
    expect(view.notice.open).toBe(true);
    view.emit("pointerdown", view.exterior);
    expect(view.notice.open).toBe(false);
    expect(view.summary.focus).not.toHaveBeenCalled();
  });

  it("does nothing on pages without the preview disclosure", () => {
    const view = fixture({ noticePresent: false });
    expect(() => view.bind()).not.toThrow();
    expect(view.doc.addEventListener).not.toHaveBeenCalled();
    expect(view.notice.addEventListener).not.toHaveBeenCalled();
    expect(view.summary.focus).not.toHaveBeenCalled();
  });

  it("serializes without dependencies and never discovers wallets, fetches, signs or reads saved sessions", () => {
    const view = fixture();
    const forbidden = () => { throw new Error("A preview wallet notice must not access external state"); };
    const context = {
      document: view.doc,
      fetch: forbidden,
      window: new Proxy({}, { get: forbidden }),
      navigator: new Proxy({}, { get: forbidden }),
      localStorage: new Proxy({}, { get: forbidden }),
      sessionStorage: new Proxy({}, { get: forbidden }),
    };
    expect(() => runInNewContext(`(${bindPreviewWalletNotice.toString()})(document)`, context)).not.toThrow();
    view.notice.open = true;
    expect(() => view.emit("pointerdown", view.interior)).not.toThrow();
    expect(() => view.emit("keydown", view.interior, "Escape")).not.toThrow();
    expect(view.notice.open).toBe(false);
    view.notice.open = true;
    expect(() => view.emit("pointerdown", view.exterior)).not.toThrow();
    expect(view.notice.open).toBe(false);
  });
});
