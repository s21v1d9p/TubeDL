/**
 * Client-side Proof-of-Origin Token (PoToken) generation via BotGuard, using
 * `bgutils-js`. This runs entirely in the browser (or Node, for testing) --
 * no server/backend involvement beyond relaying the two small BotGuard HTTP
 * calls (`Create`, `GenerateIT`) through the CORS relay like any other request.
 *
 * API shape verified against the actually-installed bgutils-js@4.0.0 (the
 * older `BG.Challenge.create()` / `BG.PoToken.generate()` namespaced API some
 * reference snippets show is from an older version and no longer exists).
 */
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';

// Public, well-known request key used by YouTube's own web client (same value
// referenced throughout LuanRT's example projects; not a secret).
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

/** @type {Map<string, Promise<import('bgutils-js/webpo').WebPoMinter>>} */
const minterPromiseByFetchTag = new Map();

async function buildMinter(fetchFn) {
  const challenge = await getChallenge({
    requestKey: REQUEST_KEY,
    fetchFunction: fetchFn,
    useYouTubeAPI: true
  });

  const interpreterJavascript = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJavascript) {
    throw new Error('BotGuard challenge response did not include interpreter javascript.');
  }

  // Google's interpreter blob unconditionally references the bare global
  // `window` (it assumes a browser). Polyfill it in non-browser environments
  // (Node test harness) so the eval below doesn't ReferenceError; a no-op
  // where `window` already exists (real browsers).
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }

  // The realm the interpreter's globals actually land in: for a real browser
  // this is plain `window` (== `globalThis`). For the Node+jsdom test
  // harness, `document`'s owning window (`document.defaultView`) is jsdom's
  // OWN separate global object -- distinct from Node's bare `globalThis` --
  // since jsdom executes appended <script> tags inside that realm, not
  // Node's. Using the wrong one here means `BotGuardClient.create()` below
  // looks for the loaded VM in an object it was never attached to.
  const vmRealm = (typeof document !== 'undefined' && document.defaultView) || globalThis.window;

  // Load the interpreter via a real <script> element (as YouTube's own web
  // client and LuanRT/kira's production downloader both do), NOT
  // `new Function(...)()`. This isn't just style: empirically, `new
  // Function()`-evaluated code is distinguishable from a normal document
  // script (no resolvable script/source position, different V8 "Script"
  // metadata) and BotGuard is Google's own anti-automation system -- it is
  // plausible (and cheap to avoid) that it fingerprints exactly this kind of
  // signal. Falls back to `new Function()` only if there's truly no `document`
  // (defensive; every real target -- browsers and the Node+jsdom test harness
  // alike -- has one).
  if (typeof document !== 'undefined') {
    const scriptId = challenge.interpreterHash || 'botguard-interpreter';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.id = scriptId;
      script.textContent = interpreterJavascript;
      (document.head || document.documentElement).appendChild(script);
    }
  } else {
    new Function(interpreterJavascript)();
  }

  const botguardClient = await BotGuardClient.create({
    globalObject: vmRealm,
    globalName: challenge.globalName,
    program: challenge.program
  });

  const webPoSignalOutput = [];
  const botguardResponse = await botguardClient.snapshot({ webPoSignalOutput });

  const integrityTokenResponse = await fetchFn(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([ REQUEST_KEY, botguardResponse ])
  });

  if (!integrityTokenResponse.ok) {
    throw new Error(`GenerateIT request failed with HTTP ${integrityTokenResponse.status}`);
  }

  const integrityTokenResponseData = await integrityTokenResponse.json();
  const integrityToken = integrityTokenResponseData?.[0];
  if (!integrityToken) {
    throw new Error('GenerateIT response did not include an integrity token.');
  }

  return WebPoMinter.create({ integrityToken }, webPoSignalOutput);
}

/**
 * Mints a PoToken bound to `identifier` (a visitor data string or video ID).
 * The underlying BotGuard VM is expensive to spin up, so it's built once and
 * cached; minting subsequent tokens (even for different identifiers) is cheap.
 * @param {string} identifier
 * @param {typeof fetch} fetchFn
 * @returns {Promise<string>}
 */
export async function getPoToken(identifier, fetchFn) {
  // Keyed so tests that swap fetch implementations don't reuse a stale minter.
  const tag = fetchFn === fetch ? 'default' : 'custom';

  if (!minterPromiseByFetchTag.has(tag)) {
    const promise = buildMinter(fetchFn).catch((err) => {
      minterPromiseByFetchTag.delete(tag);
      throw err;
    });
    minterPromiseByFetchTag.set(tag, promise);
  }

  const minter = await minterPromiseByFetchTag.get(tag);
  return minter.mintAsWebsafeString(identifier);
}

/**
 * Mints a token from a brand-new BotGuard session (fresh challenge, fresh VM,
 * fresh integrity token), bypassing the cached minter entirely.
 *
 * Used as a last-resort recovery path when YouTube's server rejects an
 * already-real (non-cold-start) token during a long-running SABR download
 * (`StreamProtectionStatus` escalates 2 -> 3, "attestation required") --
 * re-minting from the *same* cached BotGuard session reuses the same
 * integrity token underneath and empirically does not change the outcome,
 * since the mint step itself is a deterministic function of that integrity
 * token + identifier. A genuinely new challenge/response is the only thing
 * that can plausibly produce a different server-side verdict.
 * @param {string} identifier
 * @param {typeof fetch} fetchFn
 * @returns {Promise<string>}
 */
export async function getFreshPoToken(identifier, fetchFn) {
  const minter = await buildMinter(fetchFn);
  // Deliberately not cached: callers use this sparingly (one retry attempt),
  // and caching it would defeat the purpose of the *next* recovery attempt.
  return minter.mintAsWebsafeString(identifier);
}
