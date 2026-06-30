# md2pdf-onepage

Markdown を **末尾余白のない連続1ページPDF** に変換する CLI です。
Puppeteer（ヘッドレス Chrome）でレンダリングし、コンテンツの高さちょうどのページサイズで出力します。
そのため、ページ分割も後処理のトリミング（PyMuPDF 等）も不要です。

## セットアップ

```bash
cd tools/md2pdf-onepage
npm install
```

初回 `npm install` 時に Puppeteer が Chromium をダウンロードします（ネットワークが必要）。

## 使い方

```bash
# 同フォルダから
node bin/cli.mjs <input.md> [output.pdf] [options]

# 例
node bin/cli.mjs ../../User_Manual.md
node bin/cli.mjs ../../User_Manual.md out.pdf --width 280 --margin 15
node bin/cli.mjs README.md --css ./my-style.css
```

### オプション

| オプション | 説明 | 既定 |
|---|---|---|
| `-o, --out <path>` | 出力PDFパス | 入力の `.md` を `.pdf` に置換 |
| `--css <path>` | 適用するCSS | 同梱 `default.css` |
| `--width <mm>` | ページ幅（mm） | `210` |
| `--margin <mm>` | 余白（mm） | `15` |
| `-h, --help` | ヘルプ | - |

## 他プロジェクトでの利用

- このフォルダごとコピーして `npm install` → `node bin/cli.mjs ...`
- もしくは社内 Git に置いて `npm install <git-url>` でインストールし、`npx md2pdf-onepage ...`
- グローバルに使いたい場合: このフォルダで `npm link` → どこでも `md2pdf-onepage ...`

## 仕組み

1. `markdown-it` で Markdown → HTML に変換
2. ページ幅・余白を CSS（`#__doc` の width / padding）で制御し、相対画像は入力ファイルの場所を基準に解決
3. Puppeteer でレンダリング後、`#__doc` の実高さ(px)を測定
4. `page.pdf({ width, height })` に測定値を渡して **1ページ**で出力（`format` を指定しないのがポイント）

## 画像スタイル

`default.css` で画像に「薄い枠線 + 中央寄せ」を適用済みです。変更したい場合は `--css` で独自CSSを渡してください（`#__doc img { ... }` を上書き）。
