/** Shared product controls. Icon-only navigation and comparison specimens are not CTAs. */
export const SITE_ACTION_SELECTOR = "body :is(button:where(:not(.account-menu-toggle,.claim-toast button,[data-control-style] button)),.auth-action,.button,.text-button,.reauth-button)";
export const SITE_FIELD_SELECTOR = "body :is(input:where(:not([type=hidden],[type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=file],[type=range],[type=color],[data-control-style] input)),textarea,select,.open-handle-input,.grok-prompt)";

export const SITE_CONTROLS_CSS = `
/* One X-inspired control system across every product page and dialog. */
body [hidden]{display:none!important}
${SITE_ACTION_SELECTOR}{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;min-height:48px;max-width:100%;padding:var(--control-padding);border:0;border-radius:999px;background:var(--ink);color:var(--paper);font-family:var(--font-family);font-size:16px;font-weight:var(--ui-font-weight);line-height:var(--control-line-height);text-align:center;text-decoration:none;box-shadow:none;cursor:pointer;transition:background-color 120ms,color 120ms,transform 120ms}
${SITE_ACTION_SELECTOR}>span:not(.action-tooltip){color:inherit;font-size:inherit;font-weight:inherit;line-height:inherit}
body .auth-action>span:first-child{display:inline-flex;align-items:center;justify-content:center;min-width:0;max-width:100%;padding:0;border:0;border-radius:0;background:transparent}
${SITE_ACTION_SELECTOR}:not(:disabled):not([aria-disabled=true]):hover{background:var(--paper);color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
${SITE_ACTION_SELECTOR}:not(:disabled):not([aria-disabled=true]):active{transform:translateY(1px)}
${SITE_ACTION_SELECTOR}:is(:disabled,[aria-disabled=true]){opacity:.45;cursor:not-allowed}
${SITE_ACTION_SELECTOR}[aria-busy=true]{opacity:.6;cursor:progress}
${SITE_FIELD_SELECTOR}{appearance:none;display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;height:48px;min-height:48px;margin:0;padding:12px 0;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink);font-family:var(--font-family);font-size:16px;font-weight:var(--ui-font-weight);line-height:var(--control-line-height);letter-spacing:normal;box-shadow:none;transition:border-color 120ms}
${SITE_FIELD_SELECTOR}::placeholder{color:var(--muted);opacity:1}
${SITE_FIELD_SELECTOR}:not(:disabled):is(:hover,:focus){border-bottom-color:var(--ink)}
/* Fields signal focus through the underline, never an enclosing frame. */
${SITE_FIELD_SELECTOR}:is(:focus,:focus-visible){outline:none;box-shadow:none}
${SITE_FIELD_SELECTOR}:disabled{opacity:.45;cursor:not-allowed}
${SITE_FIELD_SELECTOR}:is(textarea){height:auto;resize:vertical}
${SITE_FIELD_SELECTOR}:is(select){appearance:auto;padding-inline-end:1.5rem}
body :is(input[type=radio],input[type=checkbox]){width:16px;height:16px;accent-color:var(--ink)}
body :is(.auth-account,.consent-line){min-height:48px;font-size:16px}
${SITE_ACTION_SELECTOR}:focus-visible,body :is(input[type=radio],input[type=checkbox]):focus-visible{outline:2px solid var(--ink);outline-offset:4px}
@media(prefers-reduced-motion:reduce){${SITE_ACTION_SELECTOR},${SITE_FIELD_SELECTOR}{transition:none}${SITE_ACTION_SELECTOR}:not(:disabled):active{transform:none}}
`;
