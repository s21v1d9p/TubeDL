/**
 * Node-only DOM polyfill for the BotGuard VM (used by bgutils-js's PoToken
 * generation). Google's interpreter blob assumes a real browser and touches
 * bare `window`/`document` globals during `.snapshot()`. Real browsers
 * already have both -- this file exists purely so the Node sanity-test
 * harness can exercise the *same* potoken.js code path used in production.
 *
 * NOT imported anywhere under src/extractor/ -- the shipped browser module
 * never depends on jsdom. Import this (for its side effect) before importing
 * anything from src/extractor/ in a Node test script.
 */
import { JSDOM } from 'jsdom';

if (typeof globalThis.document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.youtube.com/',
    pretendToBeVisual: true,
    // BotGuard's interpreter is now loaded via a real <script> element
    // (see potoken.js) instead of `new Function()` -- jsdom needs explicit
    // opt-in to actually execute appended script tags.
    runScripts: 'dangerously'
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // Node 21+ already defines a getter-only `navigator` global; override it.
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true
  });
}
