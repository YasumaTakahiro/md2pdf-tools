const vscode = require('vscode');
const path = require('node:path');
const { convert } = require('./convert');

/** 変換対象の .md 絶対パスを決める（コンテキストメニューの uri か、アクティブエディタ） */
async function resolveTargetMd(uri) {
  if (uri && uri.fsPath && uri.fsPath.toLowerCase().endsWith('.md')) {
    return uri.fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document && editor.document.fileName.toLowerCase().endsWith('.md')) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.fileName;
  }
  return undefined;
}

/**
 * 変換の実処理。
 *  - paged=false: 連続1ページ
 *  - paged=true, breakMode='chapter': 章(## 見出し)ごとに改ページ
 *  - paged=true, breakMode='section': 詰めて流し込み、節を分断しない
 */
async function runConvert(uri, { paged, breakMode = 'chapter' }) {
  try {
    const input = await resolveTargetMd(uri);
    if (!input) {
      vscode.window.showErrorMessage('Markdown(.md) ファイルを選択するか、エディタで開いてから実行してください。');
      return;
    }

    const cfg = vscode.workspace.getConfiguration('md2pdfOnepage');
    const widthMm = cfg.get('width', 210);
    const marginMm = cfg.get('margin', 15);
    const cssCfg = (cfg.get('cssPath', '') || '').trim();
    const cssPath = cssCfg ? cssCfg : path.join(__dirname, 'default.css');
    const openAfter = cfg.get('openAfter', true);

    const out = input.replace(/\.md$/i, '.pdf');

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PDFを生成中: ${path.basename(input)}`,
        cancellable: false,
      },
      async () => convert({ input, out, widthMm, marginMm, cssPath, paged, breakMode }),
    );

    const desc = result.paged
      ? result.breakMode === 'section'
        ? 'A4縦・節を分割せず流し込み'
        : 'A4縦・章ごと改ページ'
      : `${widthMm}mm × ${Math.round(result.heightMm)}mm, 1ページ`;
    const actions = ['開く', 'フォルダで表示'];
    const picked = await vscode.window.showInformationMessage(
      `生成しました: ${path.basename(out)} (${desc})`,
      ...actions,
    );

    const outUri = vscode.Uri.file(out);
    if (picked === 'フォルダで表示') {
      await vscode.commands.executeCommand('revealFileInOS', outUri);
    } else if (picked === '開く' || (openAfter && picked === undefined)) {
      await vscode.env.openExternal(outUri);
    }
  } catch (e) {
    const msg = (e && (e.message || String(e))) || '不明なエラー';
    vscode.window.showErrorMessage(`PDF変換に失敗しました: ${msg}`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('md2pdfOnepage.convert', (uri) =>
      runConvert(uri, { paged: false }),
    ),
    vscode.commands.registerCommand('md2pdfOnepage.convertPaged', (uri) =>
      runConvert(uri, { paged: true, breakMode: 'chapter' }),
    ),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
