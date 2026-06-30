/**
 * VSCode を使わずに変換コア(convert.js)を検証する単体スクリプト。
 * 使い方: node test-core.js <input.md> [output.pdf]
 */
const path = require('node:path');
const { convert } = require('./convert');

async function main() {
  const input = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'User_Manual.md'));
  const out = path.resolve(process.argv[3] || input.replace(/\.md$/i, '.pdf'));
  const cssPath = path.join(__dirname, 'default.css');
  const r = await convert({ input, out, widthMm: 280, marginMm: 15, cssPath });
  console.log('done:', r.out, `(${r.widthMm}mm x ${Math.round(r.heightMm)}mm)`);
}

main().catch((e) => {
  console.error('FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
