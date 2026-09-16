import { rm, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'

const PACKAGE_ID = '@dsh-external/dsh-mcp-studio'

await rm('lib', { recursive: true, force: true })

// Type declarations are emitted from the same compiler options the editor uses.
// Read tsconfig.json instead of restating the options here: a duplicated set drifts,
// and when it drifts the build fails on something the editor says is fine — which is
// how people end up hand-editing lib/ instead of fixing src/.
const configPath = 'tsconfig.json'
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error !== undefined) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext([configFile.error], {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
  process.exit(1)
}
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd())

const program = ts.createProgram({
  rootNames: parsedConfig.fileNames,
  options: {
    ...parsedConfig.options,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: 'lib/types',
    rootDir: 'src',
  },
})
const emit = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics)
if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
  process.exit(1)
}

// Host bundle: every @deepseek-ai package stays external.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'cordis'],
})

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

for (const file of ['lib/index.js', 'lib/client.js']) {
  const source = await readFile(file, 'utf8')
  await writeFile(file, source.replace(/[ \t]+$/gm, ''))
}

console.log('[dsh-mcp-studio] built Host and Web client bundles')
