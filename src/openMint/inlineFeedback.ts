/** Safe, self-contained presentation shared by the generated browser clients. */
export function renderInlineFeedback(node: HTMLElement | null, text: string, warning = false): void {
  if (!node) return;
  node.classList.remove("open-preview-notice", "open-preview-warning");
  delete node.dataset.inlineWarningMessage;
  if (!warning || !text) {
    node.textContent = text;
    return;
  }
  const shared = node.ownerDocument.querySelector?.<HTMLElement>("[data-mint-observation-warning]");
  const sharedMessage = node.ownerDocument.querySelector?.<HTMLElement>("[data-mint-observation-message]");
  if (shared && !shared.hidden && sharedMessage?.textContent === text) {
    node.textContent = "";
    return;
  }
  node.dataset.inlineWarningMessage = text;
  node.classList.add("open-preview-notice", "open-preview-warning");
  const label = node.ownerDocument.createElement("strong");
  label.className = "open-preview-notice-label";
  label.textContent = "Warning";
  const message = node.ownerDocument.createElement("span");
  message.textContent = text;
  node.replaceChildren(label, node.ownerDocument.createTextNode(" "), message);
}
