# Markdown → 連続1ページPDF（VSCode / Cursor 拡張）

`.md` を右クリックして、**末尾余白のない連続1ページPDF**に変換する拡張機能です。
変換コアは `md2pdf-onepage`（CLI版）と同じ Puppeteer 方式で、画像・表・コードに対応します。

## 機能

- エクスプローラ/エディタで `.md` を右クリック → **「連続1ページPDFに変換」**
- コマンドパレット → `md2pdf-onepage: 連続1ページPDFに変換`
- 生成後に「開く / フォルダで表示」を選択可能

## 設定（settings.json）

| 設定キー | 既定 | 説明 |
|---|---|---|
| `md2pdfOnepage.width` | `210` | ページ幅（mm） |
| `md2pdfOnepage.margin` | `15` | 余白（mm） |
| `md2pdfOnepage.cssPath` | `""` | 適用CSSの絶対パス（空なら同梱 `default.css`） |
| `md2pdfOnepage.openAfter` | `true` | 生成後にPDFを開く |

## 開発・実行（インストール方法）

### 1. 依存インストール
```bash
cd tools/md2pdf-vscode
npm install
```
初回は Puppeteer が Chromium を取得します（`md2pdf-onepage` で取得済みなら共有キャッシュを再利用）。

### 2a. デバッグ実行（手軽）
このフォルダを VSCode/Cursor で開き、`F5`（Run Extension）。新しいウィンドウで `.md` を右クリックして試せます。

### 2b. .vsix にパッケージして常用
```bash
npm install -g @vscode/vsce   # 初回のみ
vsce package                  # md2pdf-onepage-vscode-1.0.0.vsix が生成される
```
生成された `.vsix` を「拡張機能 → … → VSIX からインストール」で導入します。

### ブラウザの解決順（別PC配布対応）
変換には Chrome 系ブラウザが必要です。次の優先順で**既存のブラウザを自動検出**して使います。
1. 環境変数 `PUPPETEER_EXECUTABLE_PATH`
2. Puppeteer が取得済みの Chromium（共有キャッシュ `~/.cache/puppeteer`）
3. システムにインストール済みの **Google Chrome / Microsoft Edge / Chromium**

そのため、配布先に Chrome か Edge が入っていれば **Chromium のダウンロードは不要**です。
いずれも無い場合のみ、配布先で一度だけ `npx puppeteer browsers install chrome` を実行してください
（その際に表示されるエラーメッセージにも同じ手順を案内します）。

## コア単体テスト（VSCode不要）
```bash
node test-core.js ../../User_Manual.md
```

## 仕組み
1. `markdown-it` で Markdown → HTML
2. ページ幅・余白を CSS で制御、相対画像は入力フォルダ基準で解決（一時HTMLを `file://` で開く）
3. Puppeteer でレンダリング後、コンテンツ実高さを測定
4. `page.pdf({ width, height })` に渡して 1ページ出力（末尾余白なし）
