import { helpers, errorHandling } from '../../shared/puppeteer/puppeteerHelpers.js';
import { startServer } from '../../shared/puppeteer/staticFileServer.js';

async function evaluateWebPage(): Promise<void> {
  try {
    // テスト用のサーバーを起動
    const server = await startServer();
    const page = await server.browser.newPage();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });

    // 要件1: h1タグで「今日の天気予報」を表示
    const h1Text = await helpers.getTextContent(page, 'h1');
    if (!h1Text || h1Text !== '今日の天気予報') {
      throw new Error('要件1が満たされていません: h1タグに「今日の天気予報」が表示されていません');
    }

    // 要件2: hrで水平線を表示
    const hrExists = await page.evaluate(() => document.querySelector('hr') !== null);
    if (!hrExists) {
      throw new Error('要件2が満たされていません: hrタグによる水平線が表示されていません');
    }

    // 要件3と4: 情報をpタグで表示し、コロンは全角を使用
    const pTexts = await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('p');
      return [...paragraphs].map((p) => p.textContent.trim());
    });

    const requiredTexts = ['晴れ', '最高気温：25℃', '最低気温：18℃', '降水確率：0%'];

    // 段落の数をチェック
    if (pTexts.length < requiredTexts.length) {
      throw new Error(
        `要件3が満たされていません: 必要な情報を含む<p>タグが不足しています。期待: ${requiredTexts.length}つ、実際: ${pTexts.length}つ`
      );
    }

    // 各段落の内容をチェック
    for (const [i, expected] of requiredTexts.entries()) {
      const actual = pTexts[i];

      if (actual !== expected) {
        // コロンが半角になっていないかチェック
        if (expected.includes('：') && actual.includes(':')) {
          throw new Error('要件4が満たされていません: コロンが半角になっています。全角コロン（：）を使用してください');
        }
        throw new Error(
          `要件3または4が満たされていません: ${i + 1}番目の<p>タグの内容が正しくありません。期待: "${expected}", 実際: "${actual}"`
        );
      }
    }

    process.exit(0);
  } catch (error) {
    throw new Error(`評価中にエラーが発生しました: ${String(error)}`);
  }
}

// 評価を実行
// eslint-disable-next-line unicorn/prefer-top-level-await
evaluateWebPage().catch(errorHandling);
