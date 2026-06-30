#!/usr/bin/env node
/**
 * md2pdf-onepage
 *
 * Markdown を「末尾余白のない連続1ページPDF」に変換する。
 * Puppeteer でレンダリングし、コンテンツの高さちょうどのページサイズで出力するため、
 * ページ分割もトリミング（PyMuPDF 等）も不要。
 *
 * 使い方:
 *   md2pdf-onepage <input.md> [output.pdf] [options]
 *
 * options:
 *   -o, --out <path>     出力PDFパス（省略時は入力の .md を .pdf に置換）
 *   --css <path>         適用するCSS（省略時は同梱 default.css）
 *   --width <mm>         ページ幅（mm、既定 210）
 *   --margin <mm>        余白（mm、既定 15）
 *   -h, --help           ヘルプ表示
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const HELP = `md2pdf-onepage - Markdown を連続1ページPDF（末尾余白なし）に変換

使い方:
  md2pdf-onepage <input.md> [output.pdf] [options]

options:
  -o, --out <path>   出力PDFパス（省略時は入力の .md を .pdf に置換）
  --css <path>       適用するCSS（省略時は同梱 default.css）
  --width <mm>       ページ幅 mm（既定 210）
  --margin <mm>      余白 mm（既定 15）
  -h, --help         このヘルプ

例:
  md2pdf-onepage User_Manual.md
  md2pdf-onepage User_Manual.md out.pdf --width 280 --margin 15
  md2pdf-onepage README.md --css ./my-style.css
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--css') args.css = argv[++i];
    else if (a === '--width') args.width = argv[++i];
    else if (a === '--margin') args.margin = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

function parseMm(value, fallback) {
  if (value == null) return fallback;
  const m = String(value).match(/^([\d.]+)\s*mm$/i);
  if (m) return parseFloat(m[1]);
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function mmToPx(mm) {
  // PDF は 96dpi 基準（1px = 1/96 inch）
  return Math.round((mm * 96) / 25.4);
}

/** 利用するブラウザ実行ファイルの候補を優先順に返す（既存 Chrome/Edge/Chromium を活用） */
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

async function launchBrowser() {
  const baseArgs = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'];
  const executablePath = resolveExecutablePath();
  try {
    return await puppeteer.launch({ headless: true, args: baseArgs, executablePath });
  } catch (e1) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args._.length === 0) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const input = resolve(args._[0]);
  if (!existsSync(input)) {
    console.error('入力ファイルが見つかりません:', input);
    process.exit(1);
  }
  const out = resolve(args.out || args._[1] || input.replace(/\.md$/i, '.pdf'));

  const widthMm = parseMm(args.width, 210);
  const marginMm = parseMm(args.margin, 15);
  const widthPx = mmToPx(widthMm);
  const marginPx = mmToPx(marginMm);

  const cssPath = args.css ? resolve(args.css) : join(PKG_ROOT, 'default.css');
  const css = existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';

  const mdSrc = await readFile(input, 'utf8');
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const rendered = md.render(mdSrc);

  // 相対パスの画像などを入力ファイルの場所から解決させる
  const baseHref = pathToFileURL(dirname(input) + '/').href;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<base href="${baseHref}">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  /* ページ幅・余白はここで一括制御（余白はpaddingにして測定高さに含める） */
  #__doc { width: ${widthPx}px; padding: ${marginPx}px; box-sizing: border-box; }
${css}
</style>
</head>
<body><div id="__doc">${rendered}</div></body>
</html>`;

  // setContent() で作った文書は origin を持たず、Chromium のセキュリティで
  // file:// のローカル画像読み込みがブロックされる。そこで入力と同じフォルダに
  // 一時HTMLを書き出し、file:// として goto することで相対画像を解決させる。
  const tmpHtml = join(dirname(input), `.__md2pdf_${process.pid}.html`);
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
      /* フォント待ちは失敗しても続行 */
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

    const heightMm = (heightPx * 25.4) / 96;
    console.log(`done: ${out}  (${widthMm}mm x ${heightMm.toFixed(0)}mm, 1 page)`);
  } finally {
    await browser.close();
    try {
      await unlink(tmpHtml);
    } catch {
      /* 一時ファイル削除失敗は無視 */
    }
  }
}

main().catch((e) => {
  console.error('エラー:', e && (e.stack || e.message || e));
  process.exit(1);
});
