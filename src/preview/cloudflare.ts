// Cloudflare validates named exports as entry points; expose only the fetch Worker.
// Keep the separately exported helpers in worker.ts available to unit tests.
export { default } from "./worker.js";
