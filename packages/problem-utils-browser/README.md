# @exercode/problem-utils-browser

Puppeteer helpers, browser grading presets, and Markdown-to-PDF export.
Install this package's matching Chrome headless shell with `bun run exercode-browser browsers install chrome-headless-shell`.

See the [repository documentation](https://github.com/WillBooster/exercode-problem-utils).

`clickAndDetectCanceledSubmit(page, buttonSelector)` activates a native form control and reports whether the page cancels its submit event. It supports delegated document/window handlers and observes the form associated with the control. The temporary bubbling guard prevents default navigation when reached; it does not replace the page’s submit handler. Use this when an exercise requires the learner to cancel form submission before inspecting the resulting DOM.
