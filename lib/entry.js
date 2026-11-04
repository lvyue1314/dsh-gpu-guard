// Loader entry: re-exports the implementation through a versioned specifier so a
// profile reload picks up code changes (a plain re-import would hit the ESM cache).
export * from './index.js?v=2'
