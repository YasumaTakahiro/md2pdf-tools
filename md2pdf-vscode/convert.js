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
  return fromHeading || path.basename(inputPath).replace(/\.md$/i, '');
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
 * @param {number} [opts.widthMm]  ページ幅(mm) 既定210。paged 時は無視
 * @param {number} [opts.marginMm] 余白(mm) 既定15
 * @param {string} [opts.cssPath]  CSSパス（無ければ素のスタイル）
 * @param {boolean} [opts.paged]   true でA4縦の複数ページ出力
 * @param {('chapter'|'section')} [opts.breakMode] paged 時の改ページ方法（既定 chapter）
 *   chapter: 章(## 見出し)ごとに必ず改ページ
 *   section: 詰めて流し込み、節が分断される時だけ次ページへ送る
 * @returns {Promise<{out:string,widthMm:number,heightMm:number,paged:boolean,breakMode:string}>}
 */
async function convert({ input, out, widthMm = 210, marginMm = 15, cssPath, paged = false, breakMode = 'chapter' }) {
  // paged はA4縦固定（幅指定は無視）
  if (paged) widthMm = 210;
  if (breakMode !== 'section') breakMode = 'chapter';
  const widthPx = mmToPx(widthMm);
  const marginPx = mmToPx(marginMm);

  const css = cssPath && existsSync(cssPath) ? await readFile(cssPath, 'utf8') : '';
  const mdSrc = await readFile(input, 'utf8');
  const docTitle = resolveDocTitle(mdSrc, input);
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  // markdown-it-anchor / github-slugger は ESM のため動的 import で読み込む。
  // 見出しに id を付与（GitHub 互換 slug）して、目次の内部リンク(#...)を機能させる。
  const { default: anchor } = await import('markdown-it-anchor');
  const { default: GithubSlugger } = await import('github-slugger');
  const slugger = new GithubSlugger();
  md.use(anchor, { slugify: (s) => slugger.slug(s) });
  const rendered = md.render(mdSrc);

  const baseHref = pathToFileURL(path.dirname(input) + path.sep).href;

  // モード別レイアウトCSS。共通で節・「文章＋画像」を分断しない（詰めて流し込み）。
  //  - paged(chapter): さらに章(##=h2)を必ず新ページから開始
  //  - paged(section): 章も改ページせず続けて流し込み
  //  - 1ページ: 固定幅＋padding
  const pagedCommonCss = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  @page { size: A4 portrait; margin: ${marginMm}mm; }
  #__doc { box-sizing: border-box; }
  #__doc h1, #__doc h2, #__doc h3, #__doc h4 { break-after: avoid; }
  #__doc img, #__doc table, #__doc pre, #__doc blockquote { break-inside: avoid; }
  #__doc p:has(img), #__doc li:has(img) { break-inside: avoid; }
  #__doc .md-keep { break-inside: avoid; }
  #__doc .md-sec { break-inside: avoid; }
`;
  const layoutCss = paged
    ? breakMode === 'section'
      ? pagedCommonCss
      : `${pagedCommonCss}
  #__doc h2 { break-before: page; }
  #__doc h2:first-of-type { break-before: auto; }
`
    : `
  html, body { margin: 0; padding: 0; background: #ffffff; }
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

    if (paged) {
      // レンダリング後のDOMを加工（paged 共通）：
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

    if (paged) {
      await page.pdf({
        path: out,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      return { out, widthMm, heightMm: 297, paged: true, breakMode };
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

    return { out, widthMm, heightMm: (heightPx * 25.4) / 96, paged: false, breakMode };
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
