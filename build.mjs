// node build.mjs  → dist/index.html (single inline JS+CSS bundle) + dist/assets/*
import * as esbuild from 'esbuild';
import fs from 'node:fs'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, 'dist'); fs.mkdirSync(out, { recursive: true });
const r = await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')], bundle: true, format: 'iife', minify: true, write: false,
  target: ['es2020', 'safari15'], legalComments: 'none', loader: { '.css': 'text' },
  alias: { 'three/addons': path.join(root, 'node_modules/three/examples/jsm') },
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.existsSync(path.join(root, 'src/ui.css')) ? fs.readFileSync(path.join(root, 'src/ui.css'), 'utf8') : '';
let html = fs.readFileSync(path.join(root, 'src/shell.html'), 'utf8');
html = html.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
fs.writeFileSync(path.join(out, 'index.html'), html);
// copy assets
const src = path.join(root, 'assets'), dst = path.join(out, 'assets');
fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true, filter: f => !/\.(psd|tmp)$/i.test(f) });
fs.copyFileSync(path.join(root, 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
const kb = n => (n / 1024).toFixed(0) + ' KB';
console.log('dist/index.html', kb(fs.statSync(path.join(out, 'index.html')).size));
