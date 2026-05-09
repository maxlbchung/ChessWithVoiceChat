// Re-export Durable Object classes so the Cloudflare Pages bundler
// includes them as Worker-level exports (required for the [[migrations]]
// in wrangler.toml to register the class).
export { Matchmaker } from './api/matchmake';
