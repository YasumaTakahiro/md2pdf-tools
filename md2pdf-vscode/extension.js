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

function activate(context) {
  const disposable = vscode.commands.registerCommand('md2pdfOnepage.convert', async (uri) => {
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
        async () => convert({ input, out, widthMm, marginMm, cssPath }),
      );

      const heightMm = Math.round(result.heightMm);
      const actions = ['開く', 'フォルダで表示'];
      const picked = await vscode.window.showInformationMessage(
        `生成しました: ${path.basename(out)} (${widthMm}mm × ${heightMm}mm, 1ページ)`,
        ...actions,
      );

      const outUri = vscode.Uri.file(out);
      if (picked === 'フォルダで表示') {
        await vscode.commands.executeCommand('revealFileInOS', outUri);
      } else if (picked === '開く' || (openAfter && picked === undefined)) {
        // 既定アプリ（PDFビューア）で開く
        await vscode.env.openExternal(outUri);
      }
    } catch (e) {
      const msg = (e && (e.message || String(e))) || '不明なエラー';
      vscode.window.showErrorMessage(`PDF変換に失敗しました: ${msg}`);
    }
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
