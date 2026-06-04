/*
 * Classic content-script entry point.
 *
 * Content scripts declared in the manifest are NOT ES modules, so `import`
 * statements are unavailable here. We bootstrap the real (ESM) app by
 * dynamically importing it as a web-accessible resource — this keeps the rest
 * of the code as clean ESM and lets it reuse src/tiers/compute.mjs as-is.
 */
(async () => {
  const rt = (typeof browser !== 'undefined' ? browser : chrome).runtime;
  try {
    await import(rt.getURL('src/content/index.mjs'));
  } catch (e) {
    console.error('[poe2tf] failed to bootstrap content app:', e);
  }
})();
