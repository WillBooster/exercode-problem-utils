import { startHttpServer } from '@exercode/problem-utils';
import { createHtmlServedDirectory, launchBrowser } from '@exercode/problem-utils-browser';

await using directory = await createHtmlServedDirectory(process.argv[2]!);
await using server = startHttpServer(directory.path);
if (process.argv[3] === 'before-browser') {
  console.log(directory.path);
  await new Promise(() => {});
} else {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.text() === 'READY') console.log(directory.path);
    });
    await page.goto(server.url);
  } finally {
    await browser.close();
  }
}
