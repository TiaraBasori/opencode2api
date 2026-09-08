/** Jest ESM + TS wiring (P1 fix).
 *
 * - `type: "module"` package must use `.cjs` so Jest can load config via require().
 * - `NODE_OPTIONS=--experimental-vm-modules` (see `npm test`) keeps
 *   `jest.unstable_mockModule` + top-level await `import('../src/proxy.js')` working.
 * - `moduleNameMapper` strips NodeNext `.js` suffix so `.js` specifiers resolve
 *   to sibling `.ts` sources (`policy.js` -> `policy.ts`).
 * - transform uses @swc/jest only (no ts-jest typecheck); `tsc --noEmit` owns typecheck.
 */
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.[tj]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2022',
        },
        module: { type: 'es6' },
      },
    ],
  },
};
