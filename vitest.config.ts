// Vitest configuration. Loaded by `npm run test:unit`. Decoupled from
// vite.config.ts (which loads @vitejs/plugin-react for the app build);
// these tests run against pure Node + the Firestore emulator and don't
// need the React plugin.
//
// `include` is scoped to `tests/unit/**` so we don't accidentally pick up
// `tests/firestore.rules.test.ts` (mocha-driven, run via `npm run test:rules`).
//
// `env` is forwarded into `import.meta.env`, so the same VITE_ vars the app
// reads at runtime are available in tests. This lets the real `lib/firebase.ts`
// init against the emulator (DEV path) without any test-only code branches.
//
// The 500 ms `VITE_AK176_TEST_DELAY_MS` hook is what reproduces the
// in-flight-init race for the cancel-before-resolve assertion. In production
// the env var is unset → the conditional collapses to dead code.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/vitest.setup.ts'],
    // Each test does at least one Firestore emulator round-trip (~tens of ms)
    // and the first one waits past the 500 ms init delay. 30s is generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      VITE_FIREBASE_API_KEY: 'fake-api-key-emulator-ok',
      VITE_FIREBASE_PROJECT_ID: 'demo-medicab',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-medicab.firebaseapp.com',
      VITE_AK176_TEST_DELAY_MS: '500',
    },
  },
})
