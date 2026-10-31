import { bindHandleValidation } from "../openMint/fieldValidation.js";
import { renderInlineFeedback } from "../openMint/inlineFeedback.js";
import { mintHandleDraft } from "../openMint/mintHandleDraft.js";
import { bindDocumentPrompts } from "../openMint/promptCopy.js";
import { bindPreviewWalletNotice } from "../openMint/previewWallet.js";
import { bindAnalytics } from "./analyticsUi.js";

// Anonymous exploration only. No provider discovery, requests, wallet state,
// transaction restoration, signing or background availability polling.
bindPreviewWalletNotice(document);
// Consent first: nothing loads from Google before Allow, and only in production.
bindAnalytics(document, window);
bindDocumentPrompts(document, navigator.clipboard, renderInlineFeedback);
const form = document.querySelector<HTMLFormElement>("[data-preview-explore-form]");
if (form) {
  bindHandleValidation(form);
  const field = form.querySelector<HTMLInputElement>('input[name="handle"]');
  const save = mintHandleDraft(field);
  field?.addEventListener("input", save);
}
