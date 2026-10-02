/** Self-contained so both generated browser clients can embed it with toString(). */
export function bindHandleValidation(root: ParentNode | null): void {
  const field = root?.querySelector<HTMLInputElement>('input[name="handle"]');
  const notice = root?.querySelector<HTMLElement>("[data-handle-validation]");
  if (!field || !notice || field.dataset.handleValidationBound === "true") return;

  field.dataset.handleValidationBound = "true";
  notice.classList.add("open-preview-notice", "open-preview-warning");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  if (notice.id) {
    const descriptions = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    if (!descriptions.includes(notice.id)) descriptions.push(notice.id);
    field.setAttribute("aria-describedby", descriptions.join(" "));
  }

  const label = notice.ownerDocument.createElement("strong");
  label.className = "open-preview-notice-label";
  label.textContent = "Warning";
  const message = notice.ownerDocument.createElement("span");
  let shown = false;
  // Object methods avoid an external __name helper when tsx serializes this function.
  const validation = {
    show() {
      message.textContent = field.validity.valueMissing
        ? "Choose an X handle."
        : field.validity.patternMismatch
          ? "Use 1–15 letters, numbers, or underscores."
          : field.validationMessage || "Choose a valid X handle.";
      notice.replaceChildren(label, notice.ownerDocument.createTextNode(" "), message);
      field.setAttribute("aria-invalid", "true");
      notice.hidden = false;
      shown = true;
    },
    invalid(event: Event) {
      event.preventDefault();
      validation.show();
      field.focus();
    },
    input() {
      if (!shown) return;
      if (!field.validity.valid) {
        validation.show();
        return;
      }
      field.removeAttribute("aria-invalid");
      notice.hidden = true;
      message.textContent = "";
      shown = false;
    },
  };
  field.addEventListener("invalid", validation.invalid);
  field.addEventListener("input", validation.input);
}
