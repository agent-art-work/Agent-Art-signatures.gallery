/** Shared, bounded failure copy. This module has no wallet-client side effects. */
export function assessmentFailureText(input: { error?: unknown; errorCategory?: unknown; diagnosticReference?: unknown }): string {
  let text = typeof input.error === "string" && input.error ? input.error.slice(0, 1000) : "The assessment could not be completed. No mint transaction was submitted.";
  if (input.errorCategory === "assessment-abstained") text = "Grok could not choose a signature from the available evidence. No mint was submitted. This result will not be retried automatically.";
  if (input.errorCategory === "assessment-blocked") text = "This assessment needs operator review before it can continue. No new assessment or mint will be requested automatically.";
  if (input.errorCategory === "preparation-interrupted") text = "Your assessment was saved, but artwork preparation needs operator review. No new assessment will be requested automatically.";
  const reference = input.diagnosticReference;
  if (typeof reference === "string" && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|legacy-[a-f0-9]{24})$/.test(reference)) text += ` Reference: ${reference}.`;
  return text;
}
