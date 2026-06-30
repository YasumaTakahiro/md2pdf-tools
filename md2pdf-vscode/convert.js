/**
 * 変換コア（CommonJS）。VSCode 非依存なので単体テスト可能。
 * Markdown を「末尾余白のない連続1ページPDF」に変換する。
 */
const { readFile, writeFile, unlink } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const MarkdownIt = require('markdown-it');
const puppeteer = require('puppeteer');

function mmToPx(mm) {
  // PDF は 96dpi 基準（1px = 1/96 inch）
  return Math.round((mm * 96) / 25.4);
}

/**
 * 利用するブラウザ実行ファイルの候補を優先順に返す。
 *  1. 環境変数 PUPPETEER_EXECUTABLE_PATH
 *  2. Puppeteer が取得済みの Chromium（共有キャッシュ）
 *  3. システムにインストール済みの Chrome / Edge / Chromium
 */
function candidateBrowserPaths() {
  const list = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) list.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  try {
    const p = puppeteer.executablePath();
    if (p) list.push(p);
  } catch {
    /* 取得済み Chromium が無い場合は無視 */
  }

  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    list.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }
  return list.filter(Boolean);
}

function resolveExecutablePath() {
  for (const p of candidateBrowserPaths()) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* アクセス不可は無視 */
    }
  }
  return undefined;
}

/** ブラウザを起動（既存の Chrome/Edge/Chromium を優先。無ければ分かりやすくエラー） */
async function launchBrowser() {
  const baseArgs = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'];
  const executablePath = resolveExecutablePath();
  try {
    return await puppeteer.launch({ headless: true, args: baseArgs, executablePath });
  } catch (e1) {
    // 最後の手段: システム Chrome をチャンネル指定で試す
    try {
      return await puppeteer.launch({ headless: true, args: baseArgs, channel: 'chrome' });
    } catch {
      throw new Error(
        'Chrome / Edge / Chromium が見つかりませんでした。' +
          'Google Chrome か Microsoft Edge をインストールするか、' +
          '`npx puppeteer browsers install chrome` を実行してください。' +
          `（詳細: ${e1 && (e1.message || e1)}）`,
      );
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.input    入力 .md の絶対パス
 * @param {string} opts.out      出力 .pdf の絶対パス
 * @param {number} [opts.widthMm]  ページ幅(mm) 既定210
 * @param {number} [opts.marginMm] 余白(mm) 既定15
 * @param {string} [opts.cssPath]  CSSパス（無ければ素のスタイル）
 * @returns {Promise<{out:string,widthMm:number,heightMm:number}>}
 */
async function convert({ input, out, widthMm = 210, marginMm = 15, cssPath }) {
  const widthPx = mmToPx(widthMm);
  const marginPx = mmToPx(marginMm);

  const css = cssPath && existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';
  const mdSrc = await readFile(input, 'utf8');
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const rendered = md.render(mdSrc);

  const baseHref = pathToFileURL(path.dirname(input) + path.sep).href;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<base href="${baseHref}">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  #__doc { width: ${widthPx}px; padding: ${marginPx}px; box-sizing: border-box; }
${css}
</style>
</head>
<body><div id="__doc">${rendered}</div></body>
</html>`;

  // setContent ではローカル画像が file:// セキュリティで読めないため、
  // 入力と同じフォルダに一時HTMLを書き出して file:// で開く。
  const tmpHtml = path.join(path.dirname(input), `.__md2pdf_${process.pid}.html`);
  await writeFile(tmpHtml, html, 'utf8');

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: widthPx, height: 1000, deviceScaleFactor: 1 });
    await page.emulateMediaType('screen');
    await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: 'networkidle0' });
    try {
      await page.evaluateHandle('document.fonts.ready');
    } catch {
      /* フォント待ち失敗は無視 */
    }

    const heightPx = await page.evaluate(() => {
      const el = document.getElementById('__doc');
      const h = el ? el.getBoundingClientRect().height : document.documentElement.scrollHeight;
      return Math.ceil(h);
    });

    await page.pdf({
      path: out,
      width: `${widthPx}px`,
      height: `${heightPx}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      pageRanges: '1',
    });

    return { out, widthMm, heightMm: (heightPx * 25.4) / 96 };
  } finally {
    await browser.close();
    try {
      await unlink(tmpHtml);
    } catch {
      /* 一時ファイル削除失敗は無視 */
    }
  }
}

module.exports = { convert, mmToPx };
