import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  workspaceFolder: '.',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    // Same spec-plus-JUnit pairing the plain-Mocha tiers get from .mocharc.json (which this
    // tier does not read — @vscode/test-cli passes these options to the Mocha instance it
    // runs inside the Extension Development Host). A distinct file name so a local run of
    // both tiers doesn't have one overwrite the other.
    reporter: 'mocha-multi-reporters',
    reporterOptions: {
      reporterEnabled: 'spec, mocha-junit-reporter',
      mochaJunitReporterReporterOptions: {
        mochaFile: 'test-reports/suite.xml',
        useFullSuiteTitle: true,
        suiteTitleSeparatedBy: ' › ',
      },
    },
  },
  // Only collected when the run is started with `--coverage` (see the
  // `test:vscode-host:coverage` script) — a plain `vscode-test` run is unaffected.
  // This is @vscode/test-cli's own V8-based coverage; no instrumentation build step,
  // and no extra dependency (the unit tier uses c8 for the same reason — see .c8rc.json).
  coverage: {
    // Report against the TypeScript sources rather than the compiled `out/` tree.
    // Both inputs this tier loads carry sourcemaps: the esbuild bundle (`out/extension.js`,
    // built with --sourcemap) and the plain-tsc output (tsconfig.suite.json sets sourceMap).
    srcDir: 'src',
    exclude: ['src/test/**', 'src/interfaces/**'],
    reporter: ['text-summary', 'lcov', 'cobertura'],
    output: 'coverage/suite',
  },
});
