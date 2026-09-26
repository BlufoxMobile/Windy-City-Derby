import { boot } from './game.js';

function fatal(err) {
  console.error('[wcd] fatal', err);
  const el = document.getElementById('wcd-fatal');
  if (el) {
    el.style.display = 'flex';
    el.textContent = 'Windy City Derby hit a snag loading. Refresh to try again.';
  }
}
try { boot().catch(fatal); } catch (e) { fatal(e); }
