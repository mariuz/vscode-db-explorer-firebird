/**
 * Minimal, generic DOM/jQuery stub for loading a webview's inline `htmlContent/js/app.js` under
 * plain Node/Mocha (no real browser) so its already-exported `module.exports.__test__` hook (every
 * one of the four webview app.js files has one — result-view, schema-designer, profiler,
 * query-plan-view) can actually be exercised by a committed test, instead of only ever having been
 * checked via a one-off, uncommitted Node harness during original development (as every affected
 * roadmap doc's "Testing" section previously described).
 *
 * Deliberately generic rather than hand-listing every `document.getElementById(...)` id each file
 * happens to reference today: `document`/`window` are Proxies where any unrecognized property read
 * returns a no-op function (so `el.someButton.addEventListener(...)` — code that runs unconditionally
 * at module-load time in three of these four files, wiring up click handlers — never throws), and
 * `getElementById`/`querySelector` always return another such stub element rather than `null`. This
 * is intentionally *not* a real DOM: it only exists to get a file past its module-load-time setup so
 * the `__test__` hook's already-documented-as-pure functions (sqlLiteral, buildDDL, layoutForest,
 * matchesFilter, ...) can be called and asserted on — anything that actually needs to read back real
 * layout/rendering state (e.g. schema-designer's `render()`/`measureAll()`, which need genuine
 * text-measurement/SVG geometry) is out of scope here and not exercised by these tests.
 *
 * Usage (suite-scoped, not per-test — see individual *-webview.test.ts files): install the stubs in
 * `suiteSetup()`, load the module (which both runs its module-level setup *and* leaves the stubs in
 * place for any `__test__` function that touches document/window when actually called, not just at
 * load time), then restore the real globals in `suiteTeardown()` so they can't leak into other,
 * unrelated test files sharing the same mocha process.
 */

function makeStubElement(): any {
  const target: Record<string, any> = {
    // Writes are remembered rather than discarded, and an unset property still reads as "" the way
    // a real element's inline style does. Discarding them made every `style.display = "none"`
    // invisible to a test, so any code branching on what it had just set could not be driven at
    // all — schema-designer's loading placeholder is the concrete caller.
    style: new Proxy({} as Record<string, string>, {
      get: (t, prop: string) => (prop in t ? t[prop] : ""),
      set: (t, prop: string, value) => { t[prop] = String(value); return true; },
    }),
    classList: {
      add() { /* no-op */ },
      remove() { /* no-op */ },
      toggle() { /* no-op */ },
      contains() { return false; },
    },
    dataset: {},
    children: [],
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) { return t[prop]; }
      if (prop === "querySelectorAll" || prop === "getElementsByClassName" || prop === "getElementsByTagName") {
        return () => [];
      }
      if (prop === "querySelector" || prop === "getElementById" || prop === "cloneNode" || prop === "appendChild" || prop === "createElementNS" || prop === "createElement") {
        return () => makeStubElement();
      }
      if (prop === "getBBox" || prop === "getBoundingClientRect") {
        // SVG/DOM measurement APIs a stub has no real layout engine to answer — schema-designer's
        // measureTextWidth() (an SVG <text> element's getBBox().width) is the concrete caller —
        // return zeroed geometry rather than undefined, so `.width`/`.height` reads on the result
        // don't throw. Callers relying on genuine measured layout (render()) aren't meaningfully
        // testable against a stub DOM regardless — this only exists to keep them from crashing.
        return () => ({ width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 });
      }
      // Any other method call (addEventListener, setAttribute, removeAttribute, focus, ...)
      // becomes a harmless no-op; any other property read is undefined, matching a real DOM
      // element that simply doesn't have that property.
      return (..._args: any[]) => undefined;
    },
    // Remembered, not discarded, for the same reason as `style` above: `textContent`/`value`
    // assignments are how most of this webview code reports anything, and a stub that swallows
    // them can only ever prove a function did not throw.
    set(t, prop: string, value) { t[prop] = value; return true; },
  });
}

function makeDocumentStub(): any {
  const el = makeStubElement();
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "getElementById" || prop === "querySelector" || prop === "createElement" || prop === "createElementNS") {
        return () => makeStubElement();
      }
      if (prop === "querySelectorAll" || prop === "getElementsByClassName" || prop === "getElementsByTagName") {
        return () => [];
      }
      if (prop === "body" || prop === "documentElement") { return el; }
      return (..._args: any[]) => undefined;
    },
  });
}

/** Minimal jQuery stand-in — only result-view/app.js needs this (the other three are plain IIFEs with no jQuery dependency). `$(fn)` invokes `fn` immediately (jQuery's ready-callback semantics); `$(anythingElse)` returns a chainable no-op-method object. */
function makeJQueryStub(): any {
  const chainable: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "length") { return 0; }
      return (..._args: any[]) => chainable;
    },
  });
  const $: any = (arg: unknown) => (typeof arg === "function" ? (arg as () => void)() : chainable);
  $.fn = { DataTable: () => chainable };
  return $;
}

/** Node 20+ defines a real (read-only, non-configurable-by-default-assignment) global `navigator` — plain `global.navigator = x` throws. `Object.defineProperty` with `configurable: true` works around it, matching the same fix needed in this session's earlier scratch verification harnesses. */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(global, name, { value, configurable: true, writable: true });
}

/** Installs document/window/navigator/$/acquireVsCodeApi stubs onto the global object and returns a function that restores whatever was there before. Call in `suiteSetup()`, restore in `suiteTeardown()`. */
export function installWebviewStubs(): () => void {
  const previous = {
    document: (global as any).document,
    window: (global as any).window,
    navigator: (global as any).navigator,
    $: (global as any).$,
    acquireVsCodeApi: (global as any).acquireVsCodeApi,
  };
  const hadOwnNavigator = Object.prototype.hasOwnProperty.call(global, "navigator");

  const documentStub = makeDocumentStub();
  setGlobal("document", documentStub);
  setGlobal("window", new Proxy({ document: documentStub }, {
    get(t, prop: string) {
      if (prop in t) { return (t as any)[prop]; }
      return (..._args: any[]) => undefined;
    },
  }));
  setGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() }, platform: "" });
  setGlobal("$", makeJQueryStub());
  setGlobal("acquireVsCodeApi", () => ({ postMessage: () => { /* no-op */ } }));

  return () => {
    setGlobal("document", previous.document);
    setGlobal("window", previous.window);
    if (hadOwnNavigator) {
      setGlobal("navigator", previous.navigator);
    } else {
      delete (global as any).navigator;
    }
    setGlobal("$", previous.$);
    setGlobal("acquireVsCodeApi", previous.acquireVsCodeApi);
  };
}

/**
 * Requires `absolutePath` fresh (clearing any previous require() cache entry, since these files
 * carry meaningful top-level mutable state — draftGraph, history, pinned, etc. — so every suite
 * that loads one needs its own fresh module instance) and returns its raw `module.exports`. Most
 * of these files export `{ __test__: {...} }` directly, so callers typically do
 * `loadWebviewModule(path).__test__` — but plan-view.js exports a `{ create }` factory whose
 * `__test__` hook only exists per-instance (after calling `create()`), hence this returns the raw
 * export rather than assuming a top-level `__test__` shape. Must be called with the stubs from
 * `installWebviewStubs()` already active.
 */
export function loadWebviewModule(absolutePath: string): any {
  delete require.cache[require.resolve(absolutePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(absolutePath);
}
