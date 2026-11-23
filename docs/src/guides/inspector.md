---
sidebar_position: 9
title: Inspector
---

# Inspector

The Mobilewright Inspector is a browser-based UI for exploring the elements on a
connected device. It shows a live screenshot next to every element and the best
locator Mobilewright would use to target it — so you can pick reliable locators
without guessing.

## Open the Inspector

```bash
npx mobilewright inspect
```

The Inspector starts a local server and opens automatically in your browser. Use
`--port` to choose a specific port (default: `4621`):

```bash
npx mobilewright inspect --port 8080
```

![Mobilewright Inspector](../images/inspector.png)

## Using the Inspector

1. **Pick a device** from the selector at the top. Any connected device,
   simulator, or emulator shows up here.
2. Click **Refresh** to capture the current screen, or enable **Auto-refresh**
   and choose an interval (1 s – 1 min) to keep it in sync as you navigate the app.
3. The left pane shows the screenshot; the right pane lists every element with its
   recommended locator.
4. Click a row to highlight that element's bounding box on the screenshot, or click
   a box on the screenshot to select its row.
5. Use **Page** to switch between the native hierarchy and an available Webview.
   Element details include generated XPath and Playwright locator suggestions
   alongside raw attributes. Copy a suggestion into **Check locator** to highlight
   its matches. In Webview mode, arbitrary XPath expressions can also be checked.
   In Native mode, XPath is evaluated against the current captured hierarchy, and
   copied Playwright suggestions are checked against the available elements.
   If webview discovery times out, the native screenshot and element list remain
   available; the status bar reports the webview error. Webview choices show their
   owning app when available, and the visible target is preferred. If inspection
   fails, the Inspector stays in Webview mode so you can select another target.
   On Android, the owning app must be debuggable and have WebView debugging enabled
   for DOM inspection and XPath locators to work.

You can switch the color **Theme** (Void, Aurora, Crimson, Arctic, Synthwave) from
the header — purely cosmetic.

## Locator priority

Each element is annotated with the single best locator, following the same priority
order the [query engine](./locators) uses:

`getByTestId` &gt; `getByRole` &gt; `getByLabel` &gt; `getByText`

If two elements resolve to the same locator, both get a **`dup`** badge — a signal
that the locator isn't unique and you should add a `testID` (or pick a more specific
query) before relying on it in a test.

## Stopping the Inspector

Press `Ctrl+C` in the terminal. The Inspector disconnects from the device and shuts
the server down.
