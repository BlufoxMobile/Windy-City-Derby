// ============================================================================
// WINDY CITY DERBY — renderer + quality tiers + adaptive watchdog.
// Owner: STADIUM. API (CONTRACT.md):
//   createRenderer(canvas, { quality:'high'|'medium'|'low' }) → R
//   R: { renderer, render(scene, camera), resize(cssW, cssH), setQuality(tier), quality,
//        dispose(), beginFrame(dtSeconds) }
// Extras (optional, non-contract): opts.adaptive (default true), R.onQualityChange(tier, prev, reason)
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TIERS = ['low', 'medium', 'high'];
const DOWN = { high: 'medium', medium: 'low', low: 'low' };

export function createRenderer(canvas, { quality = 'high', adaptive = true } = {}) {
  let tier = TIERS.includes(quality) ? quality : 'high';

  // antialias is a context-creation flag: decided once. HIGH additionally renders
  // through a 4x MSAA HalfFloat target, so it stays antialiased even if the
  // context was created without MSAA.
  let renderer;
  const base = { canvas, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance' };
  try { renderer = new THREE.WebGLRenderer({ ...base, antialias: tier !== 'low' }); }
  catch (e) { console.warn('[render] retry without MSAA', e); renderer = new THREE.WebGLRenderer({ ...base, antialias: false }); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  let cssW = Math.max(1, canvas.clientWidth || innerWidth || 390);
  let cssH = Math.max(1, canvas.clientHeight || innerHeight || 844);
  let composer = null, renderPass = null, bloom = null, rt = null;
  let refreshMaterials = false;

  const dprFor = t => {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    return t === 'high' ? Math.min(dpr, 2) : t === 'medium' ? Math.min(dpr, 1.5) : 1;
  };

  function destroyComposer() {
    if (!composer) return;
    try { bloom.dispose?.(); composer.dispose?.(); rt?.dispose(); } catch (e) { /* ignore */ }
    composer = renderPass = bloom = rt = null;
  }
  function buildComposer() {
    destroyComposer();
    try {
      const pr = renderer.getPixelRatio();
      rt = new THREE.WebGLRenderTarget(Math.round(cssW * pr), Math.round(cssH * pr), { type: THREE.HalfFloatType, samples: 4 });
      composer = new EffectComposer(renderer, rt);
      renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
      composer.addPass(renderPass);
      bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(1, cssW * pr / 2), Math.max(1, cssH * pr / 2)), 0.34, 0.42, 0.86);
      // half-res bloom: the composer hands every pass the full drawing-buffer size
      const setSize = bloom.setSize.bind(bloom);
      bloom.setSize = (w, h) => setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      composer.setPixelRatio(pr);
      composer.setSize(cssW, cssH);
    } catch (e) {
      console.warn('[render] post-processing unavailable, rendering direct', e);
      destroyComposer();
    }
  }

  function apply(t) {
    const prevShadow = renderer.shadowMap.enabled + ':' + renderer.shadowMap.type;
    renderer.setPixelRatio(dprFor(t));
    renderer.shadowMap.enabled = t !== 'low';
    renderer.shadowMap.type = t === 'high' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
    renderer.shadowMap.needsUpdate = true;
    if (prevShadow !== renderer.shadowMap.enabled + ':' + renderer.shadowMap.type) refreshMaterials = true;
    renderer.setSize(cssW, cssH, false);
    if (t === 'high') buildComposer(); else destroyComposer();
  }

  // ------------------------------------------------------------ watchdog
  // EMA of frame time; if it stays above 22 ms for ~2 s (after a warm-up), step
  // down one tier. Only ever steps DOWN on its own → can never oscillate.
  const WD = { ema: 1 / 60, over: 0, warm: 0, enabled: !!adaptive };

  const R = {
    renderer,
    get quality() { return tier; },
    onQualityChange: null,
    render(scene, camera) {
      if (refreshMaterials && scene) {
        refreshMaterials = false;
        scene.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.needsUpdate = true; }); });
      }
      if (composer) {
        renderPass.scene = scene; renderPass.camera = camera;
        try { composer.render(); return; } catch (e) { console.warn('[render] composer failed, falling back', e); destroyComposer(); }
      }
      renderer.render(scene, camera);
    },
    resize(w, h) {
      cssW = Math.max(1, Math.round(w || cssW)); cssH = Math.max(1, Math.round(h || cssH));
      renderer.setPixelRatio(dprFor(tier));
      renderer.setSize(cssW, cssH, false);
      if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(cssW, cssH); }
    },
    setQuality(t, reason = 'user') {
      if (!TIERS.includes(t)) return tier;
      const prev = tier;
      tier = t; apply(t);
      WD.over = 0; WD.warm = 0; WD.ema = 1 / 60;
      if (reason === 'user') WD.enabled = !!adaptive; // a manual pick re-arms the watchdog
      if (prev !== t) { try { R.onQualityChange?.(t, prev, reason); } catch (e) { console.warn(e); } }
      return tier;
    },
    beginFrame(dt) {
      if (!WD.enabled || !(dt > 0) || dt > 0.25) return; // hidden tab / hitch: ignore
      WD.warm += dt;
      WD.ema += (dt - WD.ema) * 0.06;
      if (WD.warm < 3) return;
      if (WD.ema > 0.022) WD.over += dt; else WD.over = Math.max(0, WD.over - dt * 0.5);
      if (WD.over >= 2 && tier !== 'low') {
        const next = DOWN[tier];
        console.info(`[render] quality ${tier} → ${next} (avg frame ${(WD.ema * 1000).toFixed(1)} ms)`);
        R.setQuality(next, 'watchdog');
      }
    },
    get adaptive() { return WD.enabled; },
    set adaptive(v) { WD.enabled = !!v; WD.over = 0; WD.warm = 0; },
    get stats() { const i = renderer.info; return { calls: i.render.calls, tris: i.render.triangles, tier, ema: WD.ema }; },
    dispose() { destroyComposer(); renderer.dispose(); },
  };
  apply(tier);
  return R;
}
