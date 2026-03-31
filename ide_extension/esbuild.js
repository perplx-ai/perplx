// @ts-check
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

/**
 * Plugin to resolve the 'perplx-tool' bare specifier to the sibling tool/src.
 * Also handles .js → .ts resolution for the tool's ESM-style imports.
 */
/** @type {import('esbuild').Plugin} */
const resolveToolPlugin = {
  name: 'resolve-perplx-tool',
  setup(build) {
    const toolSrc = path.resolve(__dirname, '..', 'tool', 'src');

    // Bare specifier 'perplx-tool' → tool/src/index.ts
    build.onResolve({ filter: /^perplx-tool$/ }, () => ({
      path: path.join(toolSrc, 'index.ts'),
    }));

    // JSON theme files used by the tool
    build.onResolve({ filter: /\.json$/ }, (args) => {
      if (args.resolveDir.includes(path.join('tool', 'src'))) {
        return { path: path.resolve(args.resolveDir, args.path) };
      }
      return undefined;
    });
  },
};

/** Extension host bundle (Node, CJS) */
const extensionConfig = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: './dist/extension.js',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'warning',
  // Let esbuild resolve .js imports to .ts within the tool source
  resolveExtensions: ['.ts', '.js', '.json'],
  // import.meta.url is used by the tool for bun detection — harmless when empty in CJS
  define: {
    'import.meta.url': JSON.stringify(''),
  },
  plugins: [resolveToolPlugin, esbuildProblemMatcherPlugin],
};

/** Webview bundle (browser, ESM) */
const webviewConfig = {
  entryPoints: ['./src/webview/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: './dist/webview.js',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'warning',
  plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
  try {
    if (watch) {
      const [extCtx, webCtx] = await Promise.all([
        esbuild.context(extensionConfig),
        esbuild.context(webviewConfig),
      ]);
      await Promise.all([extCtx.watch(), webCtx.watch()]);
    } else {
      await Promise.all([
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
      ]);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
