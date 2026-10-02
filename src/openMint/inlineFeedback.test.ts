import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderInlineFeedback } from "./inlineFeedback.js";

interface TestElement {
  tag: string; className: string; nodes: TestElement[]; text: string; textContent: string; dataset: Record<string, string>;
  replaceChildren(...nodes: TestElement[]): void;
  ownerDocument: { createElement(tag: string): TestElement; createTextNode(text: string): TestElement; querySelector?(selector: string): { hidden?: boolean; textContent?: string } | null };
  classList: { add(...names: string[]): void; remove(...names: string[]): void };
}

function element(tag = "p"): TestElement {
  const node: TestElement = {
    tag, className: "", nodes: [], text: "", dataset: {},
    get textContent(): string { return this.nodes.length ? this.nodes.map(child => child.textContent).join("") : this.text; },
    set textContent(value: string) { this.nodes = []; this.text = value; },
    replaceChildren(...nodes: TestElement[]) { this.nodes = nodes; this.text = ""; },
    ownerDocument: { createElement: element, createTextNode: (text: string) => { const child = element("#text"); child.textContent = text; return child; } },
    classList: {
      add(...names: string[]) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove(...names: string[]) { node.className = node.className.split(/\s+/).filter(name => name && !names.includes(name)).join(" "); },
    },
  };
  return node;
}

describe("inline warning feedback", () => {
  it("styles failures with an amber-label hook and a separate plain-text message", () => {
    const node = element(); node.className = "open-feedback preserved";
    renderInlineFeedback(node as unknown as HTMLElement, "Mint options could not be checked.", true);
    expect(node.className).toBe("open-feedback preserved open-preview-notice open-preview-warning");
    expect(node.dataset.inlineWarningMessage).toBe("Mint options could not be checked.");
    expect(node.nodes[0]).toMatchObject({ tag: "strong", className: "open-preview-notice-label", textContent: "Warning" });
    expect(node.nodes[2]).toMatchObject({ tag: "span", textContent: "Mint options could not be checked." });
    expect(node.textContent).toBe("Warning Mint options could not be checked.");
  });

  it("restores ordinary progress and removes the warning title when clearing or recovering", () => {
    const node = element(); node.className = "open-feedback";
    renderInlineFeedback(node as unknown as HTMLElement, "Unavailable", true);
    renderInlineFeedback(node as unknown as HTMLElement, "Wallet connected.");
    expect(node.className).toBe("open-feedback");
    expect(node.textContent).toBe("Wallet connected.");
    expect(node.nodes).toHaveLength(0);
    expect(node.dataset.inlineWarningMessage).toBeUndefined();
    renderInlineFeedback(node as unknown as HTMLElement, "Unavailable", true);
    renderInlineFeedback(node as unknown as HTMLElement, "", true);
    expect(node.className).toBe("open-feedback");
    expect(node.textContent).toBe("");
  });

  it("never inserts user or server messages as HTML and does not duplicate labels", () => {
    const node = element();
    renderInlineFeedback(node as unknown as HTMLElement, '<img src=x onerror="bad()">', true);
    renderInlineFeedback(node as unknown as HTMLElement, "<script>bad()</script>", true);
    expect(node.nodes).toHaveLength(3);
    expect(node.nodes[2].tag).toBe("span");
    expect(node.nodes[2].textContent).toBe("<script>bad()</script>");
    expect(node.className).toBe("open-preview-notice open-preview-warning");
  });

  it("skips absent surfaces and serializes without module/global dependencies", () => {
    expect(() => renderInlineFeedback(null, "Unavailable", true)).not.toThrow();
    const node = element();
    runInNewContext(`(${renderInlineFeedback.toString()})(node, "Unavailable", true)`, { node });
    expect(node.textContent).toBe("Warning Unavailable");
  });

  it("does not duplicate a visible shared network warning or suppress an unrelated local error", () => {
    const node = element(); node.className = "open-feedback";
    const shared = { hidden: false };
    node.ownerDocument.querySelector = selector => selector === '[data-mint-observation-warning]' ? shared
      : selector === '[data-mint-observation-message]' ? { textContent: 'Unavailable' } : null;
    renderInlineFeedback(node as unknown as HTMLElement, 'Unavailable', true);
    expect(node.textContent).toBe('');
    expect(node.className).toBe('open-feedback');
    expect(node.dataset.inlineWarningMessage).toBeUndefined();
    renderInlineFeedback(node as unknown as HTMLElement, 'Connect a wallet.', true);
    expect(node.textContent).toBe('Warning Connect a wallet.');
    shared.hidden = true;
    renderInlineFeedback(node as unknown as HTMLElement, 'Unavailable', true);
    expect(node.textContent).toBe('Warning Unavailable');
  });
});
