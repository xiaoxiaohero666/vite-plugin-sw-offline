/**
 * 根据各皮肤 offline.html 生成 preview.html（内联公用脚本，便于 file:// 预览）
 * 用法：node scripts/build-offline-previews.js
 */

const fs = require('fs');
const path = require('path');
const { buildOfflinePageScript, buildOfflinePageStyles } = require('../src/index.js');

const ROOT = path.join(__dirname, '..');
const SKINS_DIR = path.join(ROOT, 'templates', 'skins');

const LOGO_DEMO_STYLE = {
  aurora: 'background:linear-gradient(145deg,#a78bfa,#6366f1,#22d3ee);color:#fff',
  sunset: 'background:linear-gradient(145deg,#fb923c,#f43f5e);color:#fff',
  ocean: 'background:linear-gradient(145deg,#0891b2,#06b6d4);color:#fff',
  neon: 'background:linear-gradient(145deg,#ec4899,#a855f7);color:#fff;box-shadow:0 0 20px rgba(236,72,153,.35)',
  minimal: 'background:#0f172a;color:#fff',
  galaxy: 'background:linear-gradient(145deg,#8b5cf6,#6366f1);color:#fff;box-shadow:0 0 24px rgba(139,92,246,.4)',
  matrix: 'background:#052e16;color:#4ade80;border:1px solid #4ade80',
  liquid: 'background:linear-gradient(145deg,#8b5cf6,#ec4899);color:#fff',
  cybergrid: 'background:#020617;color:#22d3ee;border:1px solid #22d3ee;box-shadow:0 0 16px rgba(34,211,238,.4)',
  prism: 'background:linear-gradient(90deg,#6366f1,#ec4899,#f97316);color:#fff'
};

const pageScript = buildOfflinePageScript({ offlineDomain: 'www.example.com' });
const pageStyles = buildOfflinePageStyles();

function buildPreview(skinId) {
  const offlinePath = path.join(SKINS_DIR, skinId, 'offline.html');
  if (!fs.existsSync(offlinePath)) return;

  let html = fs.readFileSync(offlinePath, 'utf-8');
  const style = LOGO_DEMO_STYLE[skinId] || LOGO_DEMO_STYLE.aurora;
  const logoBlock = [
    '<div class="logo-wrap" id="logoWrap">',
    '<div class="logo-demo" style="width:88px;height:88px;border-radius:22px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;margin:0 auto;',
    style,
    '" aria-hidden="true">A</div>',
    '</div>',
    '<div class="search-bar">'
  ].join('');

  html = html.replace(
    /<div class="logo-wrap" id="logoWrap">[\s\S]*?<\/div>\s*<div class="search-bar">/,
    logoBlock
  );
  html = html.replace('__OFFLINE_PAGE_STYLES__', pageStyles);
  html = html.replace('__OFFLINE_PAGE_SCRIPT__', pageScript);

  fs.writeFileSync(path.join(SKINS_DIR, skinId, 'preview.html'), html);
  console.log('preview -> templates/skins/' + skinId + '/preview.html');
}

if (!fs.existsSync(SKINS_DIR)) {
  console.error('skins dir missing');
  process.exit(1);
}

for (const name of fs.readdirSync(SKINS_DIR)) {
  if (fs.existsSync(path.join(SKINS_DIR, name, 'offline.html'))) {
    buildPreview(name);
  }
}
