/** Test-only browser driver, served by the disposable rehearsal relay, NEVER
 * by the site. Normal app handlers perform every wallet/session/mint action. */
export function stagingBrowserDriver({ control, scenario }) {
  const key = "sg-test-flow", read = () => JSON.parse(sessionStorage.getItem(key) || "null");
  const save = value => sessionStorage.setItem(key, JSON.stringify(value));
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const wait = async (fn, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
    throw Error("Timed out: " + label + "; " + document.body.innerText.slice(-1800));
  };
  const command = async action => {
    const response = await fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const result = await response.json(); check(response.ok, result.error || action); return result;
  };
  const finish = async extra => {
    await document.fonts.ready;
    const images = [...document.querySelectorAll(".signature-art img")];
    await Promise.all(images.map(i => i.decode()));
    check(!document.querySelector('meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"]'), "Private or Confirming page must not expose social metadata");
    const result = { ...read(), ...extra, privateSocialMetadata: true, images: images.length, imagesLoaded: images.every(i => i.naturalWidth > 0),
      overflow: document.documentElement.scrollWidth > innerWidth, path: location.pathname };
    save(result); document.body.dataset.stagingTestResult = "done";
  };
  async function run() {
    let state = read();
    if (!state && location.pathname === "/mint") {
      state = { phase: "entry", scenario, stages: [] }; save(state);
      await wait(() => document.querySelector("[data-connect-wallet]:not(:disabled)"), "wallet connection button");
      document.querySelector("[data-connect-wallet]").click();
      await wait(() => document.querySelector("[data-assessment-request] button[type=submit]:not(:disabled)"), "verified wallet");
      check(!document.cookie.includes("__Host-sg-staging") && !document.cookie.includes("sg_open_session"), "Session cookie must be HttpOnly");
      state.phase = "submitted"; state.stages.push("connected-with-SIWE"); save(state);
      document.querySelector("[data-assessment-request] button[type=submit]").click(); return;
    }
    if (!state) return; // Public gallery QA in a fresh, signed-out browser.
    const progress = /^\/mint\/([A-Za-z0-9_-]{43})$/.exec(location.pathname);
    if (progress && state.phase === "submitted") {
      const code = progress[1], submissionKey = "sg-open:submission:" + code;
      check(!document.body.innerText.includes("ENFP"), "Assessment must remain hidden before inclusion");
      if (scenario === "revoked") {
        await wait(() => /This page has not sent a wallet transaction/.test(document.body.innerText), "revoked dispatch feedback");
        await command("revoked-check");
        check(!document.body.innerText.includes("wallet response is uncertain"), "Pre-wallet failure must not be described as a wallet response");
        state.stages.push("review-withdrawal-blocks-send"); state.phase = "complete"; save(state);
        await finish({ blocked: true }); return;
      }
      await wait(() => {
        const saved = JSON.parse(sessionStorage.getItem(submissionKey) || "null");
        return saved?.permit && (scenario === "uncertain" ? saved.uncertain && /uncertain|Check wallet activity/i.test(document.body.innerText) : saved.hash);
      }, "saved wallet outcome");
      const inspected = await command("restart");
      check(inspected.state === "pending", "Reported outcome must not reveal");
      state.stages.push("one-send", "hidden-before-inclusion", "site-restart"); state.phase = "reloaded"; save(state);
      // A missing browser journal must NOT erase the durable server permit.
      if (scenario === "uncertain") {
        sessionStorage.removeItem(submissionKey); sessionStorage.removeItem("sg-open:intent:" + code);
      }
      location.reload(); return;
    }
    if (progress && state.phase === "reloaded") {
      await wait(() => /outcome is unknown|Check wallet activity|Waiting|Transaction submitted|Mint submitted/i.test(document.body.innerText), "pending after reload");
      await command("pending-check");
      check(!document.querySelector("[data-submit-mint]:not(:disabled)") || document.querySelector("[data-mint-form]")?.hidden, "Reload must not offer another send");
      state.stages.push("reload-no-duplicate-send");
      if (scenario === "uncertain") {
        await command("logout");
        state.phase = "signed-out"; save(state); location.assign("/mint?handle=Alice"); return;
      }
      state.phase = "confirming"; save(state); await command("include"); return; // Actual client polling performs the reveal navigation.
    }
    if (state.phase === "signed-out" && location.pathname === "/mint") {
      await wait(() => document.querySelector("[data-connect-wallet]:not(:disabled)"), "signed-out entry");
      check(document.querySelector("[data-assessment-request] button[type=submit]").disabled, "New session needs wallet proof");
      await command("signed-out-check");
      state.stages.push("session-revoked-no-retry"); state.phase = "complete"; save(state); await finish({ blocked: true }); return;
    }
    if (state.phase === "confirming" && location.pathname === "/signatures/alice") {
      await wait(() => document.querySelector("[data-mint-state=confirming]"), "verified Confirming reveal");
      const gallery = await (await fetch("/api/gallery")).json(); check(gallery.items.length === 0, "Unfinalized artwork entered gallery");
      check(document.body.innerText.includes("@ALIce") && document.body.innerText.includes("ENFP"), "Wrong revealed caption");
      state.phase = "complete"; state.stages.push("canonical-Confirming", "gallery-empty-before-finality"); save(state);
      await finish({ state: "confirming" });
    }
  }
  void run().catch(error => {
    save({ ...read(), error: String(error.message) }); document.body.dataset.stagingTestResult = "failed";
  });
}
