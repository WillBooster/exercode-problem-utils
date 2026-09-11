import { parseFrontmatter, startLocalHttpServer } from '@exercode/problem-utils';
import type { Page } from 'playwright-core';
import { Marked } from 'marked';
import markedCjkFriendly from 'marked-cjk-friendly';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';
import { z } from 'zod';
import { launchBrowser } from './browser.js';
import { markdownStyles, highlightStyles } from './markdownStyles.js';

type PdfOptions = NonNullable<Parameters<Page['pdf']>[0]>;
export interface MarkdownPdfOptions {
  assetDirectoryPath: string;
  css?: string;
  pdfOptions?: PdfOptions;
  mermaidScriptPath?: string;
}

export async function markdownToPdf(markdown: string, options: MarkdownPdfOptions): Promise<Buffer> {
  const marked = new Marked({
    renderer: {
      code({ text, lang }) {
        const language = lang?.split(/\s/u)[0] ?? '';
        const knownLanguage = hljs.getLanguage(language) ? language : 'plaintext';
        const highlighted = hljs.highlight(text, { language: knownLanguage }).value;
        const className = language === 'mermaid' ? 'language-mermaid' : `hljs language-${knownLanguage}`;
        return `<pre><code class="${className}">${highlighted}</code></pre>`;
      },
    },
  });
  marked.use(markedCjkFriendly(), gfmHeadingId());
  const body = await marked.parse(markdownBody(markdown));
  await using server = await startLocalHttpServer(options.assetDirectoryPath);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route(`${server.url}/`, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
      })
    );
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: markdownStyles + highlightStyles });
    if (options.css) await page.addStyleTag({ content: options.css });
    if (options.mermaidScriptPath) {
      await page.addScriptTag({ path: options.mermaidScriptPath });
      await page.evaluate(async () => {
        for (const code of document.querySelectorAll('pre > code.language-mermaid')) {
          const container = document.createElement('div');
          container.className = 'mermaid';
          container.textContent = code.textContent;
          code.parentElement?.replaceWith(container);
        }
        const { mermaid } = globalThis as typeof globalThis & {
          mermaid: { initialize: (options: { startOnLoad: boolean }) => void; run: () => Promise<void> };
        };
        mermaid.initialize({ startOnLoad: false });
        await mermaid.run();
      });
    }
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.allSettled(Array.from(document.images, (image) => image.decode()));
    });
    return await page.pdf({
      printBackground: true,
      format: options.pdfOptions?.width || options.pdfOptions?.height ? undefined : 'A4',
      margin: { top: '30mm', right: '40mm', bottom: '30mm', left: '20mm' },
      ...options.pdfOptions,
    });
  } finally {
    await browser.close();
  }
}

function markdownBody(markdown: string): string {
  try {
    const parsed = parseFrontmatter(markdown);
    return z.record(z.string(), z.unknown()).safeParse(parsed.attributes).success ? parsed.body : markdown;
  } catch {
    return markdown;
  }
}
