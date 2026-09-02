import { build } from 'esbuild';

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['main.js'],
  outdir: '.build/main',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['preload.js'],
  outdir: '.build/preload',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: {
    'main-window': 'src/ui/main-window.js',
    'settings-window': 'src/ui/settings-window.js',
    onboarding: 'onboarding.js',
  },
  outdir: '.build/renderer',
  platform: 'browser',
  format: 'iife',
  target: 'chrome134',
});

console.log('Application entry points compiled to .build/');
