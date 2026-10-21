// Replaces node-fetch for the demo (see mock.mjs), so every request gaxios makes goes to the mock.
export default (...args) => globalThis.fetch(...args);
