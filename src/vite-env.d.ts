/// <reference types="vite/client" />
// Brings in Vite's ambient types (import.meta.env.PROD / BASE_URL, asset module
// declarations). tsconfig restricts `types` to vitest/globals, but a triple-slash
// reference is independent of that list, so this stays in effect for tsc + build.
