import { startHttpServer } from '@exercode/problem-utils';
import { captureHtmlScreenshot, createHtmlServedDirectory, launchBrowser } from '@exercode/problem-utils-browser';
import { expect, test } from 'vitest';

test('HTML screenshot distinguishes the example stylesheet colors', async () => {
  await using model = await createHtmlServedDirectory('example/web_page_comparison/model_answers/default');
  await using answer = await createHtmlServedDirectory('example/web_page_comparison/model_answers.test/wrong_style');
  await using modelServer = startHttpServer(model.path);
  await using answerServer = startHttpServer(answer.path);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    const screenshots = await Promise.all(
      pages.map((page, index) => captureHtmlScreenshot(page, index === 0 ? modelServer.url : answerServer.url))
    );
    if (screenshots[0]!.equals(screenshots[1]!)) {
      const states = await Promise.all(
        pages.map((page) =>
          page.evaluate<string>(`JSON.stringify({
        color: getComputedStyle(document.querySelector('h1')).color,
        heading: document.querySelector('h1').outerHTML,
        bounds: document.querySelector('h1').getBoundingClientRect().toJSON(),
        fonts: document.fonts.status,
        sheets: Array.from(document.styleSheets, sheet => ({href: sheet.href, rules: Array.from(sheet.cssRules, rule => rule.cssText)}))
      })`)
        )
      );
      console.error('HTML_RENDERING_DIAGNOSTIC', JSON.stringify(states), screenshots[0]!.toString('base64'));
    }
    expect(screenshots[0]!.equals(screenshots[1]!)).toBe(false);
  } finally {
    await browser.close();
  }
});
