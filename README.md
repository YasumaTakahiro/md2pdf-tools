# md2pdf-tools

Markdown を **末尾余白のない連続1ページPDF** に変換するツール群です。
Puppeteer（ヘッドレス Chrome）でレンダリングし、コンテンツの高さちょうどのページサイズで出力するため、ページ分割も後処理のトリミングも不要です。画像・表・コードに対応します。

任意のプロジェクトから再利用できるよう、勤怠管理リポジトリから分離した汎用ツールです。

## 構成

| フォルダ | 種類 | 用途 |
|---|---|---|
| [`md2pdf-onepage`](./md2pdf-onepage) | Node CLI | ターミナル / CI 向け。`node bin/cli.mjs input.md` |
| [`md2pdf-vscode`](./md2pdf-vscode) | VSCode/Cursor 拡張 | `.md` を右クリック →「連続1ページPDFに変換」 |

両者は同じ変換ロジック（Puppeteer 方式）を使います。

## ブラウザの解決順（Chromium 同梱不要）

変換には Chrome 系ブラウザが必要です。次の優先順で**既存ブラウザを自動検出**します。

1. 環境変数 `PUPPETEER_EXECUTABLE_PATH`
2. Puppeteer が取得済みの Chromium（共有キャッシュ `~/.cache/puppeteer`）
3. システムの **Google Chrome / Microsoft Edge / Chromium**

Chrome か Edge が入っていれば追加ダウンロードは不要です。いずれも無い場合のみ
`npx puppeteer browsers install chrome` を実行してください。

## クイックスタート（CLI）

```bash
cd md2pdf-onepage
npm install
node bin/cli.mjs path/to/input.md            # input.pdf を生成
node bin/cli.mjs input.md out.pdf --width 280 --margin 15
```

詳細は各フォルダの README を参照してください。
