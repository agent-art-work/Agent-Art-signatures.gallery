# Offline mobile and accessibility regression

The home, mint, and Sepolia admin pages use one typography/control/navigation system. This audit exercises the actual templates, local Playpen Sans assets, styles, slogan motion, and inline handle validation with synthetic data. It never loads the production wallet client, reads RPC, signs a message, sends a transaction, calls X/Grok, or changes mint policy.

Run with Node 22+ and a local Chrome/Chromium binary:

```sh
node --import tsx scripts/pulse-ui-accessibility.mjs --output-dir /private/tmp/sg-ui-accessibility
```

`CHROME_PATH` can select an installed browser. The runner discovers standard macOS and Linux installations otherwise. Missing Chrome is a failure, not a silent skip. CI runs the same command in its isolated Pulse regression job and keeps the evidence directory as an artifact.

## Coverage

| Surface | Sale states | Themes | Responsive widths |
| --- | --- | --- | --- |
| Home | Free, paid | Light, dark | 320, 375, 390 CSS px; 200% zoom reflow |
| Mint | Free, paid, checking availability | Light, dark | Same |
| Admin | Synthetic policy editing and pending recovery | Light, dark | Same |

There are 48 cases. The zoom case represents a 1280×900 physical viewport at 200% zoom as 640×450 CSS pixels with device-scale factor 2. It tests responsive reflow and enlarged rendering, not an operating-system font-size preference.

Each case checks document/content bounds, 44px navigation targets, 48px form controls, identical header alignment, named interactive controls, a page heading in Chrome's accessibility tree, polite live status regions, real Tab traversal, visible keyboard focus, underline-only input focus, and reduced-motion behavior. Mint cases also check accessible sale-section naming and inline invalid-handle feedback. Admin cases confirm visual address wrapping leaves the actual newline-separated slot rows unchanged.

`results.json` records computed geometry, keyboard order, accessibility-tree counts, request status, and screenshot paths. The runner fails on missing assets, browser exceptions, or any request outside its isolated loopback fixture server. Screenshot review is still required when changing visual styles; passing geometry alone is not a design review.

## October 2, 2026 findings and fixes

- Home guidance had shrunk to 7.68px at a 375px viewport to retain a single line. It now stays 16px and wraps naturally.
- At 320px, the receiving address and network label were squeezed beside the wallet button. The wallet controls now stack below 600px, preserving full-width address wrapping.
- The admin allowlist field's forced `white-space:pre` hid address prefixes after horizontal scrolling. Soft visual wrapping now preserves the typed newline rows and slot order.
- Mint retains its input-first visual layout, with a hidden page heading for assistive navigation. The sale section is named by its live heading instead of a stale initial phase label.
- Sale feedback and the admin state badge expose atomic status announcements.

The 48-case browser audit passed with no failed asset requests, external requests, or JavaScript errors. Representative screenshots were inspected in both themes, including narrow screens, mint recovery, admin pending hashes, and zoom reflow.

This is not a manual VoiceOver/NVDA certification or a signed mint/admin transaction test. Existing client/service tests cover transaction lifecycle safety separately; actual allowlist economics, paid pricing, and hosted release acceptance remain outside this policy-independent check.
