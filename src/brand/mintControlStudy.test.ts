import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { HOME_LINK } from "../v1/navigation.js";
import { mintPage } from "../openMint/pages.js";
import { MINT_CONTROL_STUDIES, MINT_CONTROL_STUDY_CSS, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_SCRIPT, MINT_CONTROL_STUDY_SCRIPT_PATH, mintControlStudyPage } from "./mintControlStudy.js";

describe("mint input and button comparison", () => {
  it("shows five paired styles with identical copy and independently labelled fields", () => {
    const html = mintControlStudyPage();
    expect(MINT_CONTROL_STUDIES.map(style => style.id)).toEqual(["hairline", "ink", "frame", "continuous", "x-pill"]);
    expect(html).toContain("Same words, 5 treatments.");
    expect(html.match(/data-control-style=/g)).toHaveLength(5);
    expect(html.match(/>Mint &amp; reveal</g)).toHaveLength(5);
    expect(html.match(/placeholder="@handle"/g)).toHaveLength(5);
    expect(html.match(/role="status" aria-live="polite"/g)).toHaveLength(10);
    for (const style of MINT_CONTROL_STUDIES) {
      expect(html).toContain(`for="mcs-input-${style.id}"`);
      expect(html).toContain(`id="mcs-input-${style.id}"`);
      expect(html).toContain(`aria-describedby="mcs-validation-${style.id} mcs-status-${style.id}"`);
      expect(html).toContain(`id="mcs-validation-${style.id}" class="open-preview-notice open-preview-warning" data-handle-validation role="status" aria-live="polite" hidden`);
      expect(html).toContain(`id="mcs-title-${style.id}"`);
    }
  });

  it("adds a scoped X-inspired pill as option 05 with a quiet field and no arrow", () => {
    const pill = mintControlStudyPage().match(/<article\b[^>]*data-control-style="x-pill"[^>]*>.*?<\/article>/)![0];
    expect(pill).toContain('data-style-number="05"');
    expect(pill).toContain("X-inspired pill");
    expect(pill).toContain("Quiet underlined field / solid pill button");
    expect(pill).not.toMatch(/mcs-arrow|↗/);

    const input = MINT_CONTROL_STUDY_CSS.match(/\[data-control-style=x-pill\] input\{([^}]+)\}/)![1];
    expect(input).toContain("padding-inline:0");
    expect(input).toContain("border-bottom:1px solid var(--line)");

    const button = MINT_CONTROL_STUDY_CSS.match(/\[data-control-style=x-pill\] \.mcs-button\{([^}]+)\}/)![1];
    for (const declaration of ["border-radius:999px", "border:0", "background:var(--ink)", "color:var(--paper)", "padding-inline:24px", "font-weight:500"]) {
      expect(button).toContain(declaration);
    }
    expect(MINT_CONTROL_STUDY_CSS).toMatch(/\[data-control-style=x-pill\] \.mcs-button>span\{[^}]*font-weight:inherit/);
    const hover = MINT_CONTROL_STUDY_CSS.match(/\[data-control-style=x-pill\] \.mcs-button:hover\{([^}]+)\}/)![1];
    for (const declaration of ["background:var(--paper)", "color:var(--ink)", "box-shadow:inset 0 0 0 1px var(--ink)"]) {
      expect(hover).toContain(declaration);
    }
  });

  it("uses shared navigation and theme assets without real mint hooks or a developer overlay", () => {
    const html = mintControlStudyPage("/assets/sepolia.css");
    expect(html).toContain('class="book-page mcs-page"');
    expect(html).toContain(HOME_LINK);
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain('href="/assets/sepolia.css"');
    expect(html).toContain(`href="${MINT_CONTROL_STUDY_CSS_PATH}"`);
    expect(html).toContain(`src="${MINT_CONTROL_STUDY_SCRIPT_PATH}"`);
    expect(html).toContain('content="noindex,nofollow"');
    expect(html).toContain("They do not mint.");
    expect(html).not.toMatch(/<form\b|data-open-mint|data-assessment-request|data-request-submit|data-wallet|rehearsal-watermark|sepolia-readiness\.js|\/assets\/sepolia\.js/);
    for (const button of html.match(/<button\b[^>]*>/g)!) expect(button).toContain('type="button"');
    expect(MINT_CONTROL_STUDY_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|ethereum|localStorage|sessionStorage|\.submit\(/);
    expect(mintControlStudyPage('/assets/x.css" onload="bad')).toContain('href="/assets/x.css&quot; onload=&quot;bad"');
  });

  it("keeps the live mint page separate from comparison markup and styling", () => {
    const html = mintPage("Alice", { chainName: "Ethereum Sepolia" });
    expect(html).toContain("data-assessment-request");
    expect(html).not.toMatch(/mcs-|data-control-style|mint-control-study/);
    expect(MINT_CONTROL_STUDY_CSS).not.toMatch(/(?:^|})\s*\.(?:auth-action|mint-entry|open-mint-form)\b/);
    expect(MINT_CONTROL_STUDY_CSS).toContain("font-size:16px");
    expect(MINT_CONTROL_STUDY_CSS).toContain("min-height:48px");
    expect(MINT_CONTROL_STUDY_CSS).toContain(":focus-visible");
    expect(MINT_CONTROL_STUDY_CSS).toContain("[data-control-style=x-pill] input:is(:focus,:focus-visible){outline:none;box-shadow:none}");
    expect(MINT_CONTROL_STUDY_CSS).toContain("prefers-reduced-motion:reduce");
    expect(MINT_CONTROL_STUDY_CSS).toContain("var(--ink)");
    expect(MINT_CONTROL_STUDY_CSS).toContain("var(--paper)");
  });

  it("validates locally, reports only demo feedback and clears it on input", () => {
    const cards = MINT_CONTROL_STUDIES.map((_style, index) => {
      const input = new ValidationElement();
      input.value = "@Alice";
      const warning = new ValidationElement();
      warning.id = `mcs-validation-${MINT_CONTROL_STUDIES[index]!.id}`;
      input.setAttribute("aria-describedby", `${warning.id} mcs-status-${MINT_CONTROL_STUDIES[index]!.id}`);
      const status = { textContent: "" };
      const buttonHandlers: Record<string, () => void> = {};
      const button = { addEventListener(event: string, handler: () => void) { buttonHandlers[event] = handler; } };
      return { input, warning, status, buttonHandlers, dataset: { styleNumber: String(index + 1).padStart(2, "0") },
        querySelector(selector: string) { return selector === "input" || selector === 'input[name="handle"]' ? input : selector === "button" ? button : selector === "[data-handle-validation]" ? warning : selector === "[data-control-feedback]" ? status : null; } };
    });
    runInNewContext(MINT_CONTROL_STUDY_SCRIPT, { document: { querySelectorAll: () => cards } });
    for (const card of cards) {
      card.buttonHandlers.click!();
      expect(card.status.textContent).toBe(`Style ${card.dataset.styleNumber} · @Alice — demo only.`);
      card.input.emit("input");
      expect(card.status.textContent).toBe("");
      card.input.value = "";
      card.buttonHandlers.click!();
      expect(card.status.textContent).toBe("");
      expect(card.warning.hidden).toBe(false);
      expect(card.warning.nodes.map(node => node.textContent).join("")).toBe("Warning Choose an X handle.");
      expect(card.input.getAttribute("aria-invalid")).toBe("true");
      expect(card.input.nativePopupShown).toBe(false);
      expect(card.input.focusCount).toBe(1);
      card.input.value = "bad handle";
      card.input.emit("input");
      expect(card.warning.nodes.map(node => node.textContent).join("")).toBe("Warning Use 1–15 letters, numbers, or underscores.");
      card.input.value = "@Alice";
      card.input.emit("input");
      expect(card.warning.hidden).toBe(true);
      expect(card.input.getAttribute("aria-invalid")).toBeNull();
      expect(card.status.textContent).toBe("");
      card.buttonHandlers.click!();
      expect(card.status.textContent).toBe(`Style ${card.dataset.styleNumber} · @Alice — demo only.`);
      expect(card.warning.hidden).toBe(true);
      expect(card.input.listeners.get("invalid")).toHaveLength(1);
    }
  });

  it("matches the site's amber-title and normal-content warning style in both themes", () => {
    expect(MINT_CONTROL_STUDY_CSS).toContain('.mcs-page .open-preview-warning{--preview-warning:#806014');
    expect(MINT_CONTROL_STUDY_CSS).toContain('border-inline-start:1px solid var(--preview-warning);background:transparent');
    expect(MINT_CONTROL_STUDY_CSS).toContain('color:var(--ink);font-size:14px;line-height:1.6');
    expect(MINT_CONTROL_STUDY_CSS).toContain('.mcs-page .open-preview-notice-label{display:inline;font-weight:500;color:var(--preview-warning)}');
    expect(MINT_CONTROL_STUDY_CSS).toContain('.mcs-page .open-preview-notice-label::after{content:":"}');
    expect(MINT_CONTROL_STUDY_CSS).toContain('@media(prefers-color-scheme:dark){.mcs-page .open-preview-warning{--preview-warning:#c6a65a}}');
    expect(MINT_CONTROL_STUDY_CSS).toContain('.mcs-page [data-handle-validation][hidden]{display:none}');
  });
});

class ValidationElement {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: Event) => void>>();
  nodes: ValidationElement[] = [];
  id = "";
  value = "";
  textContent = "";
  className = "";
  hidden = true;
  focusCount = 0;
  nativePopupShown = false;
  ownerDocument = {
    createElement: () => new ValidationElement(),
    createTextNode: (textContent: string) => Object.assign(new ValidationElement(), { textContent }),
  };
  classList = { add: (...names: string[]) => { this.className = names.join(" "); } };
  get validity() {
    const valueMissing = this.value === "";
    const patternMismatch = !valueMissing && !/^@?[A-Za-z0-9_]{1,15}$/.test(this.value);
    return { valueMissing, patternMismatch, valid: !valueMissing && !patternMismatch };
  }
  get validationMessage() { return this.validity.valid ? "" : "Browser warning"; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  replaceChildren(...nodes: ValidationElement[]) { this.nodes = nodes; }
  addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  focus() { this.focusCount++; }
  emit(type: string) {
    const event = new Event(type, { cancelable: true });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  reportValidity() {
    if (this.validity.valid) return true;
    this.nativePopupShown = !this.emit("invalid").defaultPrevented;
    return false;
  }
}
