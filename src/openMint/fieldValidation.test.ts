import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bindHandleValidation } from "./fieldValidation.js";

type Listener = (event: Event) => void;
class Element {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  nodes: Element[] = [];
  hidden = true;
  className = "";
  textContent = "";
  id = "";
  value = "";
  required = true;
  pattern = "@?[A-Za-z0-9_]{1,15}";
  focusCount = 0;
  ownerDocument = {
    createElement: (tag: string) => Object.assign(new Element(), { tag }),
    createTextNode: (textContent: string) => Object.assign(new Element(), { textContent }),
  };
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
  };
  get validity() {
    const valueMissing = this.required && this.value === "";
    const patternMismatch = this.value !== "" && !new RegExp(`^(?:${this.pattern})$`).test(this.value);
    return { valueMissing, patternMismatch, valid: !valueMissing && !patternMismatch };
  }
  get validationMessage() { return this.validity.valid ? "" : "Browser validation message"; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  replaceChildren(...nodes: Element[]) { this.nodes = nodes; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  focus() { this.focusCount += 1; }
  emit(type: string) {
    const event = new Event(type, { cancelable: true });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function setup() {
  const field = new Element();
  const notice = new Element();
  notice.id = "handle-validation";
  const root = {
    querySelector: (selector: string) => selector === 'input[name="handle"]' ? field : selector === "[data-handle-validation]" ? notice : null,
  } as unknown as ParentNode;
  const bind = () => bindHandleValidation(root);
  const text = () => notice.nodes.map((node) => node.textContent).join("");
  return { field, notice, root, bind, text };
}

describe("inline handle validation", () => {
  it("suppresses the browser popup, focuses the invalid field and shows the styled required warning", () => {
    const { field, notice, bind, text } = setup();
    bind();
    expect(notice.hidden).toBe(true);
    expect(field.emit("invalid").defaultPrevented).toBe(true);
    expect(field.focusCount).toBe(1);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(notice.hidden).toBe(false);
    expect(notice.className).toBe("open-preview-notice open-preview-warning");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.nodes[0]).toMatchObject({ tag: "strong", className: "open-preview-notice-label", textContent: "Warning" });
    expect(notice.nodes[2]).toMatchObject({ tag: "span", textContent: "Choose an X handle." });
    expect(text()).toBe("Warning Choose an X handle.");
    expect(field.required).toBe(true);
    expect(field.pattern).toBe("@?[A-Za-z0-9_]{1,15}");
    expect(field.validity.valid).toBe(false);
  });

  it("updates the relevant warning during invalid typing and clears it once the native constraints pass", () => {
    const { field, notice, bind, text } = setup();
    bind();
    field.value = "@";
    field.emit("input");
    expect(notice.hidden).toBe(true);
    field.emit("invalid");
    expect(text()).toBe("Warning Use 1–15 letters, numbers, or underscores.");
    for (const value of ["alice bob", "é", "a".repeat(16), "@@alice", "<script>"]) {
      field.value = value;
      field.emit("input");
      expect(notice.hidden).toBe(false);
      expect(text()).toBe("Warning Use 1–15 letters, numbers, or underscores.");
    }
    field.value = "";
    field.emit("input");
    expect(text()).toBe("Warning Choose an X handle.");
    field.value = "@Alice_Bob_12345";
    field.emit("input");
    expect(field.validity.valid).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(notice.hidden).toBe(true);
    expect(notice.nodes[2].textContent).toBe("");
    expect(field.focusCount).toBe(1);
    field.value = "@";
    field.emit("input");
    expect(notice.hidden).toBe(true);
  });

  it("preserves existing descriptions and installs each listener once", () => {
    const { field, bind } = setup();
    field.setAttribute("aria-describedby", "mint-explanation request-feedback");
    bind();
    bind();
    expect(field.getAttribute("aria-describedby")).toBe("mint-explanation request-feedback handle-validation");
    expect(field.listeners.get("invalid")).toHaveLength(1);
    expect(field.listeners.get("input")).toHaveLength(1);
    field.emit("invalid");
    expect(field.focusCount).toBe(1);
    const described = setup();
    described.field.setAttribute("aria-describedby", "handle-validation mint-explanation");
    described.bind();
    expect(described.field.getAttribute("aria-describedby")).toBe("handle-validation mint-explanation");
  });

  it("gracefully skips pages without a handle field or warning target", () => {
    expect(() => bindHandleValidation(null)).not.toThrow();
    expect(() => bindHandleValidation({ querySelector: () => null } as unknown as ParentNode)).not.toThrow();
    const field = new Element();
    bindHandleValidation({ querySelector: (selector: string) => selector === 'input[name="handle"]' ? field : null } as unknown as ParentNode);
    expect(field.listeners.size).toBe(0);
    expect(field.dataset.handleValidationBound).toBeUndefined();
  });

  it("runs when serialized into a generated client with no module closure", () => {
    const { root, field, notice } = setup();
    runInNewContext(`(${bindHandleValidation.toString()})(document)`, { document: root });
    field.emit("invalid");
    expect(notice.hidden).toBe(false);
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });
});
