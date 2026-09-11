#!/usr/bin/env node

await import(new URL('./cli.js', import.meta.resolve('playwright-core/package.json')).href);
