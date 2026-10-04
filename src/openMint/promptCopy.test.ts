import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { bindDocumentPrompts } from "./promptCopy.js";

type ClickHandler = () => Promise<void>;
type ClipboardWriter = Parameters<typeof bindDocumentPrompts>[1];
const controls = [
  { name: "reading", button: "[data-copy-about-reading]", field: "[data-about-reading-prompt]", note: "[data-about-reading-feedback]" },
  { name: "preview", button: "[data-copy-handoff]", field: "[data-handoff-prompt]", note: "[data-copy-feedback]" },
] as const;

function fixture() {
  const surfaces = controls.map(control => {
    const handlers = new Map<string, ClickHandler>();
    const button = { addEventListener: vi.fn((event: string, handler: ClickHandler) => { handlers.set(event, handler); }) };
    const disclosure = { open: false };
    const field = {
      value: `${control.name} prompt\nwith a second line`, focus: vi.fn(), select: vi.fn(),
      closest: vi.fn((_selector: string): { open: boolean } | null => disclosure),
    };
    const note = { id: control.name };
    return { ...control, buttonNode: button, fieldNode: field, noteNode: note, disclosure, handlers };
  });
  const nodes = new Map<string, unknown>();
  for (const surface of surfaces) {
    nodes.set(surface.button, surface.buttonNode);
    nodes.set(surface.field, surface.fieldNode);
    nodes.set(surface.note, surface.noteNode);
  }
  const root = { querySelector: vi.fn((selector: string) => nodes.get(selector) ?? null) };
  const feedback = vi.fn<Parameters<typeof bindDocumentPrompts>[2]>();
  const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
  return {
    surfaces, nodes, root, feedback, clipboard,
    bind(writer: ClipboardWriter = clipboard) {
      bindDocumentPrompts(root as unknown as Pick<Document, "querySelector">, writer, feedback);
    },
  };
}

describe("independent document-prompt copy controls", () => {
  it("binds each button to its own field and feedback, without copying at initialization", async () => {
    const view = fixture();
    view.bind();
    expect(view.clipboard.writeText).not.toHaveBeenCalled();
    expect(view.feedback).not.toHaveBeenCalled();
    for (const [index, surface] of view.surfaces.entries()) {
      expect(surface.buttonNode.addEventListener.mock.calls).toEqual([["click", expect.any(Function)]]);
      await surface.handlers.get("click")!();
      expect(view.clipboard.writeText).toHaveBeenNthCalledWith(index + 1, surface.fieldNode.value);
      expect(view.feedback).toHaveBeenNthCalledWith(index + 1, surface.noteNode, "Copied.");
      expect(surface.fieldNode.focus).not.toHaveBeenCalled();
      expect(surface.fieldNode.select).not.toHaveBeenCalled();
      expect(surface.fieldNode.closest).not.toHaveBeenCalled();
      expect(surface.disclosure.open).toBe(false);
    }
    expect(view.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(view.feedback).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])("reads control %s's current text at click time and copies it verbatim", async index => {
    const view = fixture();
    view.bind();
    const surface = view.surfaces[index]!;
    surface.fieldNode.value = 'Updated @ExactCase\n<script>not executable</script> & "quoted"';
    await surface.handlers.get("click")!();
    expect(view.clipboard.writeText.mock.calls).toEqual([[surface.fieldNode.value]]);
    expect(view.feedback.mock.calls).toEqual([[surface.noteNode, "Copied."]]);
  });

  it.each([0, 1])("waits for control %s's clipboard write before reporting success", async index => {
    const view = fixture();
    let finish!: () => void;
    view.clipboard.writeText.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    view.bind();
    const operation = view.surfaces[index]!.handlers.get("click")!();
    expect(view.feedback).not.toHaveBeenCalled();
    finish();
    await operation;
    expect(view.feedback.mock.calls).toEqual([[view.surfaces[index]!.noteNode, "Copied."]]);
  });

  for (const failure of ["denied", "unavailable", "missing method", "synchronous error"] as const) {
    it.each([0, 1])(`selects only control %s's prompt when the clipboard is ${failure}`, async index => {
      const view = fixture();
      let writer: ClipboardWriter = view.clipboard;
      if (failure === "denied") view.clipboard.writeText.mockRejectedValue(new Error("Permission denied"));
      if (failure === "unavailable") writer = undefined;
      if (failure === "missing method") writer = {} as ClipboardWriter;
      if (failure === "synchronous error") view.clipboard.writeText.mockImplementation(() => { throw new Error("Unavailable"); });
      bindDocumentPrompts(view.root as unknown as Pick<Document, "querySelector">, writer, view.feedback);
      const surface = view.surfaces[index]!;
      const other = view.surfaces[1 - index]!;
      surface.fieldNode.focus.mockImplementation(() => { expect(surface.disclosure.open).toBe(true); });
      surface.fieldNode.select.mockImplementation(() => { expect(surface.fieldNode.focus).toHaveBeenCalledOnce(); });
      await expect(surface.handlers.get("click")!()).resolves.toBeUndefined();
      expect(surface.fieldNode.closest.mock.calls).toEqual([["details"]]);
      expect(surface.disclosure.open).toBe(true);
      expect(surface.fieldNode.focus).toHaveBeenCalledOnce();
      expect(surface.fieldNode.select).toHaveBeenCalledOnce();
      expect(other.disclosure.open).toBe(false);
      expect(other.fieldNode.closest).not.toHaveBeenCalled();
      expect(other.fieldNode.focus).not.toHaveBeenCalled();
      expect(other.fieldNode.select).not.toHaveBeenCalled();
      expect(view.feedback.mock.calls).toEqual([[surface.noteNode, "Select and copy the prompt."]]);
    });
  }

  for (const missing of ["button", "field"] as const) {
    it.each([0, 1])(`skips an incomplete control %s with no ${missing} and keeps the other working`, async index => {
      const view = fixture();
      const incomplete = view.surfaces[index]!;
      const complete = view.surfaces[1 - index]!;
      view.nodes.delete(incomplete[missing]);
      expect(() => view.bind()).not.toThrow();
      expect(incomplete.buttonNode.addEventListener).not.toHaveBeenCalled();
      expect(incomplete.handlers.size).toBe(0);
      await complete.handlers.get("click")!();
      expect(view.clipboard.writeText.mock.calls).toEqual([[complete.fieldNode.value]]);
      expect(view.feedback.mock.calls).toEqual([[complete.noteNode, "Copied."]]);
    });
  }

  it.each(["no ancestor", "no closest method"])("keeps manual-copy fallback working with %s", async missing => {
    const view = fixture();
    view.clipboard.writeText.mockRejectedValue(new Error("Permission denied"));
    for (const surface of view.surfaces) {
      if (missing === "no ancestor") surface.fieldNode.closest.mockReturnValue(null);
      else Reflect.deleteProperty(surface.fieldNode, "closest");
    }
    view.bind();
    for (const surface of view.surfaces) {
      await expect(surface.handlers.get("click")!()).resolves.toBeUndefined();
      expect(surface.fieldNode.focus).toHaveBeenCalledOnce();
      expect(surface.fieldNode.select).toHaveBeenCalledOnce();
      expect(surface.disclosure.open).toBe(false);
    }
    expect(view.feedback.mock.calls).toEqual(view.surfaces.map(surface => [surface.noteNode, "Select and copy the prompt."]));
  });

  it.each([false, true])("tolerates an absent feedback surface (clipboard denied=%s)", async denied => {
    const view = fixture();
    for (const surface of view.surfaces) view.nodes.delete(surface.note);
    if (denied) view.clipboard.writeText.mockRejectedValue(new Error("Permission denied"));
    view.bind();
    for (const surface of view.surfaces) await expect(surface.handlers.get("click")!()).resolves.toBeUndefined();
    expect(view.feedback).toHaveBeenCalledTimes(2);
    for (const call of view.feedback.mock.calls) expect(call).toEqual([null, denied ? "Select and copy the prompt." : "Copied."]);
  });

  it("does nothing when the page has neither prompt control", () => {
    const view = fixture();
    view.nodes.clear();
    expect(() => view.bind()).not.toThrow();
    expect(view.clipboard.writeText).not.toHaveBeenCalled();
    expect(view.feedback).not.toHaveBeenCalled();
    for (const surface of view.surfaces) expect(surface.handlers.size).toBe(0);
  });

  it("serializes without module dependencies and never fetches, connects a wallet or signs", async () => {
    const view = fixture();
    const fetch = vi.fn(() => { throw new Error("Copy must not perform network requests"); });
    const request = vi.fn(() => { throw new Error("Copy must not interact with a wallet"); });
    runInNewContext(`(${bindDocumentPrompts.toString()})(root, clipboard, feedback)`, {
      root: view.root, clipboard: view.clipboard, feedback: view.feedback,
      fetch, ethereum: { request }, window: { fetch, ethereum: { request } },
    });
    for (const surface of view.surfaces) await surface.handlers.get("click")!();
    view.clipboard.writeText.mockRejectedValue(new Error("Permission denied"));
    for (const surface of view.surfaces) await surface.handlers.get("click")!();
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(view.clipboard.writeText).toHaveBeenCalledTimes(4);
    expect(view.feedback).toHaveBeenCalledTimes(4);
  });
});
