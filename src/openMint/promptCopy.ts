import type { renderInlineFeedback } from "./inlineFeedback.js";

/** Self-contained for both serialized browser clients; copying is a local action. */
export function bindDocumentPrompts(root: Pick<Document, "querySelector">, clipboard: Pick<Clipboard, "writeText"> | undefined, feedback: typeof renderInlineFeedback): void {
  for (const [buttonSelector, fieldSelector, feedbackSelector] of [
    ["[data-copy-about-reading]", "[data-about-reading-prompt]", "[data-about-reading-feedback]"],
    ["[data-copy-handoff]", "[data-handoff-prompt]", "[data-copy-feedback]"],
  ]) {
    const button = root.querySelector<HTMLElement>(buttonSelector!);
    const field = root.querySelector<HTMLTextAreaElement>(fieldSelector!);
    if (!button || !field) continue;
    const note = root.querySelector<HTMLElement>(feedbackSelector!);
    button.addEventListener("click", async () => {
      try {
        if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
        await clipboard.writeText(field.value);
        feedback(note, "Copied.");
      } catch {
        const disclosure = field.closest?.("details") as HTMLDetailsElement | null;
        if (disclosure) disclosure.open = true;
        field.focus();
        field.select();
        feedback(note, "Select and copy the prompt.");
      }
    });
  }
}
