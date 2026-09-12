# @exercode/problem-utils-browser

Puppeteer helpers, browser grading presets, and Markdown-to-PDF export.
Install this package's matching Chrome headless shell with `bun run exercode-browser browsers install chrome-headless-shell`.

See the [repository documentation](https://github.com/WillBooster/exercode-problem-utils).

`clickAndDetectCanceledSubmit(page, buttonSelector)` uses a native Puppeteer pointer click to activate a visible form control and reports whether the page cancels its submit event. It supports delegated document/window handlers and observes the form associated with the control. Checks on the same page run sequentially so their navigation guards do not affect each other. Invisible or unclickable controls return `false`. The temporary bubbling guard prevents default navigation when reached; it does not replace the page’s submit handler. If an uncanceled submission navigates before its result can be read, the helper returns `false`. Use this when an exercise requires the learner to cancel form submission before inspecting the resulting DOM. Create the page with `createBrowserPage` before navigating to learner content (as the presets do): it observes submit events before learner scripts, including window capture handlers that stop immediate propagation. Load this interactive content with `page.goto`: the initial blank document is not instrumented, and `page.setContent`/`document.open` replace document listeners and lose the early observer.

`submitFormAndCaptureRequest(page, selector, timeoutMs)` clicks a form control and captures its main-frame navigation as `{ method, path, params }` without sending the submission to the server. It supports URL-encoded GET/POST fields and returns `undefined` when no navigation occurs before the timeout (2 seconds by default). Use it on a page without another request-interception handler. Its temporary interception is removed after success, timeout, or click failure.
