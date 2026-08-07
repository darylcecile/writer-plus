import { strictEqual, ok } from "node:assert/strict";

// Proves the extension VM works inside the real WKWebView.
//
// This spec exists because WebKit enforces CSP for WebAssembly: a policy
// regression would not fail any unit test, it would just silently leave the
// app with no working extensions. Safari is a close proxy for WKWebView but
// it is not the same runtime and it does not load the app's real CSP the way
// Tauri serves it, so the only honest verification is here, in the shipped
// window.
describe("extension VM in WKWebView", function () {
  it("compiles WebAssembly under the app's real CSP", async function () {
    await $("#root > *").waitForExist({ timeout: 15_000 });

    // The smallest valid WASM module: the 8-byte header alone. If CSP blocks
    // WASM this throws `CompileError: Refused to create a WebAssembly object`,
    // which is exactly the failure the `'wasm-unsafe-eval'` directive exists
    // to prevent.
    const result = await browser.executeAsync((done) => {
      void (async () => {
        try {
          const header = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
          await WebAssembly.compile(header);
          done(null);
        } catch (e) {
          done(e && e.message ? e.message : String(e));
        }
      })();
    });

    strictEqual(result, null, `WebAssembly.compile was blocked: ${result}`);
  });

  it("reports a working VM from the in-app self test", async function () {
    await $("#root > *").waitForExist({ timeout: 15_000 });

    // The badge is required, not optional: the E2E build sets VITE_E2E=1 so
    // it renders. If it is missing, the build is misconfigured and treating
    // that as a pass would defeat the point of the test.
    const badge = await $('[data-testid="vm-self-test"]');
    await badge.waitForExist({ timeout: 15_000 });

    // The badge starts as "pending" and settles once the module loads.
    await browser.waitUntil(async () => (await badge.getAttribute("data-ok")) !== "pending", {
      timeout: 30_000,
      timeoutMsg: "VM self test never settled",
    });

    const okAttr = await badge.getAttribute("data-ok");
    const engine = await badge.getAttribute("data-engine");

    // Record which engine actually ran. Falling back to asm.js still passes
    // but is a meaningful signal: it means WASM was unavailable.
    console.log(`    -> QuickJS engine in WKWebView: ${engine}`);

    strictEqual(okAttr, "true", `self test failed on engine ${engine}`);
    ok(engine === "wasm" || engine === "asmjs", `unexpected engine ${engine}`);
  });
});
