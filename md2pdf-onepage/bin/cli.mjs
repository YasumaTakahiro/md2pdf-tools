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
 *   --width <mm>         ページ幅（mm、既定 210）。--paged 指定時は無視
 *   --margin <mm>        余白（mm、既定 15）
 *   --paged              A4縦の複数ページで出力
 *   --break <mode>       --paged 時の改ページ方法（既定 chapter）。
 *                        いずれも節・「文章＋画像」は分断せず詰めて流し込む。
 *                          chapter: さらに章（## 見出し）を必ず新ページから開始
 *                          section: 章も改ページせず続けて流し込む
 *   --emit-html          PDFと一緒に検証用HTML（<出力>.html）も書き出す
 *   --export-css <path>  同梱の default.css を <path> に書き出して終了
 *   -h, --help           ヘルプ表示
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import GithubSlugger from 'github-slugger';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const HELP = `md2pdf-onepage - Markdown を連続1ページPDF（末尾余白なし）に変換

使い方:
  md2pdf-onepage <input.md> [output.pdf] [options]

options:
  -o, --out <path>   出力PDFパス（省略時は入力の .md を .pdf に置換）
  --css <path>       適用するCSS（省略時は同梱 default.css）
  --width <mm>       ページ幅 mm（既定 210）。--paged 指定時は無視
  --margin <mm>      余白 mm（既定 15）
  --paged            A4縦の複数ページで出力
  --break <mode>     --paged 時の改ページ方法（既定 chapter）。
                     どちらも節・「文章＋画像」は分断せず詰めて流し込む。
                       chapter: さらに章（## 見出し）を必ず新ページから開始
                       section: 章も改ページせず続けて流し込む
  --emit-html        PDFと一緒に検証用HTML（<出力>.html）も書き出す
  --export-css <path> 同梱の default.css を <path> に書き出して終了
  -h, --help         このヘルプ

例:
  md2pdf-onepage User_Manual.md
  md2pdf-onepage User_Manual.md out.pdf --width 280 --margin 15
  md2pdf-onepage User_Manual.md --paged
  md2pdf-onepage User_Manual.md --paged --emit-html
  md2pdf-onepage --export-css ./my-style.css
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--css') args.css = argv[++i];
    else if (a === '--width') args.width = argv[++i];
    else if (a === '--margin') args.margin = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--paged') args.paged = true;
    else if (a === '--break') args.break = argv[++i];
    else if (a === '--emit-html') args.emitHtml = true;
    else if (a === '--export-css') args.exportCss = argv[++i];
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** PDFのタイトル（ビューアのヘッダー表示）。先頭のH1見出し、無ければファイル名。 */
function resolveDocTitle(mdSrc, inputPath) {
  const m = mdSrc.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  const fromHeading = m && m[1].trim();
  return fromHeading || basename(inputPath).replace(/\.md$/i, '');
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

  // --export-css: 同梱の default.css を書き出して終了（変換はしない）
  if (args.exportCss) {
    const dest = resolve(args.exportCss);
    const srcCss = join(PKG_ROOT, 'default.css');
    await writeFile(dest, await readFile(srcCss, 'utf8'), 'utf8');
    console.log('exported css:', dest);
    return;
  }

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

  const paged = !!args.paged;
  const breakMode = args.break === 'section' ? 'section' : 'chapter';
  // --paged はA4縦固定（幅指定は無視）。1ページモードは従来どおり幅指定可。
  const widthMm = paged ? 210 : parseMm(args.width, 210);
  const marginMm = parseMm(args.margin, 15);
  const widthPx = mmToPx(widthMm);
  const marginPx = mmToPx(marginMm);

  const cssPath = args.css ? resolve(args.css) : join(PKG_ROOT, 'default.css');
  const css = existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';

  const mdSrc = await readFile(input, 'utf8');
  const docTitle = resolveDocTitle(mdSrc, input);
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  // 見出しに id を付与（GitHub 互換 slug）して、目次の内部リンク(#...)を機能させる
  const slugger = new GithubSlugger();
  md.use(anchor, { slugify: (s) => slugger.slug(s) });
  const rendered = md.render(mdSrc);

  // 相対パスの画像などを入力ファイルの場所から解決させる
  const baseHref = pathToFileURL(dirname(input) + '/').href;

  // モード別のレイアウトCSS。共通で「節・文章＋画像を分断しない（詰めて流し込み）」を効かせ、
  //  - paged(chapter): さらに章(##=h2)の直前で必ず改ページ（章は新ページ開始）。
  //  - paged(section): 強制改ページなし（章も続けて流し込み）。
  //  - 1ページ: 従来どおり固定幅＋paddingで測定高さに余白を含める。
  const pagedCommonCss = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  @page { size: A4 portrait; margin: ${marginMm}mm; }
  #__doc { box-sizing: border-box; }
  /* 見出しがページ末尾に取り残されないように */
  #__doc h1, #__doc h2, #__doc h3, #__doc h4 { break-after: avoid; }
  /* 画像・表・コードブロックはできるだけページ内で分断しない */
  #__doc img, #__doc table, #__doc pre, #__doc blockquote { break-inside: avoid; }
  /* 画像を含む段落・リスト項目（同一段落に文章＋画像があるケース）は分割しない */
  #__doc p:has(img), #__doc li:has(img) { break-inside: avoid; }
  /* 「説明文＋直下の画像」が別段落のときも、まとめて分割しない（分断時は文章ごと次ページへ） */
  #__doc .md-keep { break-inside: avoid; }
  /* 節（見出し＋本文のまとまり）はページ内で分断しない＝分断時は丸ごと次ページへ */
  #__doc .md-sec { break-inside: avoid; }
`;
  const layoutCss = paged
    ? breakMode === 'section'
      ? pagedCommonCss
      : `${pagedCommonCss}
  /* 章(H2)は必ず新しいページから開始 */
  #__doc h2 { break-before: page; }
  /* ただし最初の見出し（目次など）はタイトルと同じ先頭ページに残す */
  #__doc h2:first-of-type { break-before: auto; }
`
    : `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  /* ページ幅・余白はここで一括制御（余白はpaddingにして測定高さに含める） */
  #__doc { width: ${widthPx}px; padding: ${marginPx}px; box-sizing: border-box; }
`;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<base href="${baseHref}">
<style>
${layoutCss}
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

    if (paged) {
      // レンダリング後のDOMをページ分割しやすいよう加工する（paged 共通）。
      //  1) 「説明文＋直下の画像」を <div class="md-keep"> で束ねる
      //  2) 節（見出し＋本文）を <div class="md-sec"> で束ねる
      await page.evaluate(({ wrapLevel, doSections }) => {
        const doc = document.getElementById('__doc');
        if (!doc) return;

        const headLevel = (el) => {
          if (!el || el.nodeType !== 1) return 0;
          const m = /^H([1-6])$/.exec(el.tagName);
          return m ? parseInt(m[1], 10) : 0;
        };
        // 画像だけのブロック（<img>, <figure>, または img のみの <p>）
        const isImageBlock = (el) => {
          if (!el || el.nodeType !== 1) return false;
          if (el.tagName === 'IMG' || el.tagName === 'FIGURE') return true;
          if (el.tagName === 'P') {
            const img = el.querySelector(':scope > img');
            return !!img && el.textContent.trim() === '';
          }
          return false;
        };

        // 1) 文章の直下に画像 → 文章＋画像（連続する画像も含む）を一塊に
        {
          const children = Array.from(doc.children);
          let i = 0;
          while (i < children.length) {
            const cur = children[i];
            if (isImageBlock(cur) && i > 0) {
              const prev = children[i - 1];
              // 直前が見出しや画像でない（＝説明文と思われる）ときだけ束ねる
              if (headLevel(prev) === 0 && !isImageBlock(prev)) {
                const group = [prev, cur];
                let j = i + 1;
                while (j < children.length && isImageBlock(children[j])) {
                  group.push(children[j]);
                  j++;
                }
                const keep = document.createElement('div');
                keep.className = 'md-keep';
                prev.parentNode.insertBefore(keep, prev);
                group.forEach((g) => keep.appendChild(g));
                i = j;
                continue;
              }
            }
            i++;
          }
        }

        // 2) 節（見出し＋本文）を一塊に
        if (doSections) {
          const children = Array.from(doc.children);
          let i = 0;
          while (i < children.length) {
            const el = children[i];
            const lv = headLevel(el);
            if (lv >= wrapLevel) {
              const group = [el];
              let j = i + 1;
              while (j < children.length) {
                const lv2 = headLevel(children[j]);
                if (lv2 !== 0 && lv2 <= lv) break;
                group.push(children[j]);
                j++;
              }
              const sec = document.createElement('div');
              sec.className = 'md-sec';
              el.parentNode.insertBefore(sec, el);
              group.forEach((g) => sec.appendChild(g));
              i = j;
            } else {
              i++;
            }
          }
        }
      }, { wrapLevel: 3, doSections: true });
    }

    // --emit-html: レンダリング・DOM加工後のHTMLを検証用に書き出す
    if (args.emitHtml) {
      const htmlOut = out.replace(/\.[^.\\/]+$/, '') + '.html';
      await writeFile(htmlOut, await page.content(), 'utf8');
      console.log('emit html:', htmlOut);
    }

    if (paged) {
      // 章ごとに改ページしたA4縦の複数ページPDF。余白・サイズは @page（CSS）で制御。
      await page.pdf({
        path: out,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      const label = breakMode === 'section' ? 'flowed, section-safe' : 'paged by chapter';
      console.log(`done: ${out}  (A4 portrait, ${label})`);
    } else {
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
    }
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
