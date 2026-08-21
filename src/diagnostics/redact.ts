/**
 * What must never leave the machine inside a diagnostic bundle.
 *
 * The bundle is an attachment a user sends to an operator when something is
 * wrong, so every byte in it travels somewhere the user cannot see. That makes
 * the interesting question not "did we mask the token" but "what did we mask it
 * *with*" -- a bundle that drops the field entirely is a bundle where the
 * operator cannot tell "there was no token" from "there was a token and we hid
 * it", and those are different faults. So masking replaces a value with a
 * marker of the same shape rather than deleting the key.
 *
 * Two layers, because either alone is wrong:
 *
 *   by name       a key called `private_key_pkcs8` is a secret whatever it
 *                 holds. Exact and reliable, and blind to keys we did not name.
 *   by shape      a long opaque run of base64/hex is a secret whatever it is
 *                 called. Catches the keys we did not name, at the cost of
 *                 occasionally masking a hash that was safe to print.
 *
 * The shape pass is `safeStderr`'s regex from `src/runtime/antigravity.ts`,
 * which has been redacting Antigravity's stderr since before this file existed.
 * It is reused rather than reinvented so that one change moves both.
 *
 * Message bodies are not a secret by shape or by name -- they are prose, and no
 * regex distinguishes a user's sentence from a log line. They are excluded
 * structurally instead: nothing in the bundle carries a body field, and
 * `test/bundle-secrets.test.ts` asserts that a planted body never appears.
 */

/**
 * Masked in full wherever they appear, at any depth, whatever they contain.
 *
 * `secret_ref` is deliberately absent: it is a *name* pointing at a secret, not
 * the secret, and an operator reading a bundle needs it to say which credential
 * failed. Masking it would cost the diagnosis and buy nothing.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "private_key_pkcs8",
  "token",
  "authorization",
  "password",
  "signature",
  "sig",
  "value",
  "nonce",
  "body",
  "text",
  "content",
]);

/** Keys whose value is a URL that may carry credentials in its userinfo. */
const URL_KEYS: ReadonlySet<string> = new Set(["base_url", "rpc_ws", "api_http", "url"]);

export const MASK = "[redacted]";

/**
 * A run long enough and opaque enough to be a key, a token or a signature.
 *
 * 32 is the same threshold `safeStderr` uses. Below it live the things a
 * diagnosis needs: a `lane-<24 hex>` storage name, a uuid segment, an error
 * code. Above it live base64 keys and bearer tokens.
 */
const OPAQUE_RUN = /\b[A-Za-z0-9_+/=-]{32,}\b/g;

/**
 * Strip userinfo, leaving the part that says which host was being reached.
 *
 * `https://user:pw@hub.example/api` reduces to `https://hub.example/api`. A
 * bundle that dropped the whole URL would lose the answer to "which hub were
 * you even talking to", which is the first question asked of an unreachable
 * hub.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username === "" && url.password === "") return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not a URL. Fall through to the shape pass, which is the safer reading of
    // a string we could not parse.
    return redactText(value);
  }
}

/**
 * Mask by shape. Used on free text -- error messages, log lines, stderr.
 *
 * Ids keep their prefix: `aud_0199…` becomes `aud_[redacted]` rather than
 * `[redacted]`, because the prefix names which subsystem the id belongs to and
 * is not itself a secret. The uuid tail is masked only when it is long enough
 * to trip the opaque run, which a hyphenated uuid is not -- so in practice ids
 * survive intact and this note documents why that is deliberate rather than an
 * oversight.
 */
export function redactText(value: string): string {
  return value.replace(OPAQUE_RUN, MASK);
}

/**
 * Walk a structure and mask every secret in it.
 *
 * Returns a new value; the input is not mutated, because the caller is usually
 * holding live config that the running process still needs.
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEYS.has(key)) return MASK;
  if (typeof value === "string") {
    if (key !== undefined && URL_KEYS.has(key)) return redactUrl(value);
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        redactValue(item, name),
      ]),
    );
  }
  return value;
}
