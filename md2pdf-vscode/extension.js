const vscode = require('vscode');
const path = require('node:path');
const { convert, exportDefaultCss } = require('./convert');

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
 *  - mode='pdf', paged=false: 連続1ページ
 *  - mode='pdf', paged=true, breakMode='chapter': 章(## 見出し)ごとに改ページ
 *  - mode='html': レンダリング後のHTMLを保存（検証用）
 */
async function runConvert(uri, { paged, breakMode = 'chapter', mode = 'pdf' }) {
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

    const isHtml = mode === 'html';
    const out = input.replace(/\.md$/i, isHtml ? '.html' : '.pdf');
    const kindLabel = isHtml ? '検証用HTML' : 'PDF';

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${kindLabel}を生成中: ${path.basename(input)}`,
        cancellable: false,
      },
      async () => convert({ input, out, widthMm, marginMm, cssPath, paged, breakMode, mode }),
    );

    const desc = isHtml
      ? '検証用HTML（改ページありレイアウト）'
      : result.paged
        ? 'A4縦・章ごと改ページ'
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
    vscode.window.showErrorMessage(`${mode === 'html' ? 'HTML出力' : 'PDF変換'}に失敗しました: ${msg}`);
  }
}

/** 同梱の default.css を、対象 .md と同じフォルダ（無ければワークスペース）へ書き出す。 */
async function runExportCss(uri) {
  try {
    let dir;
    const input = await resolveTargetMd(uri);
    if (input) {
      dir = path.dirname(input);
    } else {
      const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      dir = ws ? ws.uri.fsPath : undefined;
    }
    if (!dir) {
      vscode.window.showErrorMessage('出力先フォルダを特定できません。Markdown を開くかフォルダを開いてから実行してください。');
      return;
    }

    const dest = path.join(dir, 'md2pdf-default.css');
    await exportDefaultCss(dest);

    const destUri = vscode.Uri.file(dest);
    const picked = await vscode.window.showInformationMessage(
      `デフォルトCSSを出力しました: ${path.basename(dest)}`,
      '開く',
      '設定に登録',
    );
    if (picked === '開く') {
      const doc = await vscode.workspace.openTextDocument(destUri);
      await vscode.window.showTextDocument(doc);
    } else if (picked === '設定に登録') {
      // このCSSを以降の変換で使うよう cssPath に登録（ワークスペース設定）
      await vscode.workspace
        .getConfiguration('md2pdfOnepage')
        .update('cssPath', dest, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('md2pdfOnepage.cssPath に登録しました（ワークスペース設定）。');
    }
  } catch (e) {
    const msg = (e && (e.message || String(e))) || '不明なエラー';
    vscode.window.showErrorMessage(`CSS出力に失敗しました: ${msg}`);
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
    vscode.commands.registerCommand('md2pdfOnepage.emitHtml', (uri) =>
      runConvert(uri, { paged: true, breakMode: 'chapter', mode: 'html' }),
    ),
    vscode.commands.registerCommand('md2pdfOnepage.exportCss', (uri) => runExportCss(uri)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
