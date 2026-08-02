// The callback_data codec, in its own module so both the panel (which handles
// taps) and the renderer (which now puts panel-opening buttons under match
// reports) can build buttons without importing each other.

export const CALLBACK_VERSION = "v1";

/** Telegram's hard limit on callback_data. Encoding refuses anything longer
 *  rather than shipping a button that silently fails on the phone. */
export const CALLBACK_MAX_BYTES = 64;

export interface CallbackData {
  readonly panel: string;
  readonly action: string;
  readonly arg?: string;
  readonly nonce?: string;
}

export function encodeCallback(data: CallbackData): string {
  const parts = [CALLBACK_VERSION, data.panel, data.action, data.arg ?? "", data.nonce ?? ""];
  // Trailing empties are dropped so the common "just navigate" button stays short.
  while (parts.length > 3 && parts[parts.length - 1] === "") parts.pop();
  const encoded = parts.join(":");
  if (Buffer.byteLength(encoded, "utf8") > CALLBACK_MAX_BYTES) {
    throw new Error(`callback data too long for Telegram: ${encoded}`);
  }
  return encoded;
}

export function decodeCallback(raw: string): CallbackData | null {
  const parts = raw.split(":");
  if (parts.length < 3 || parts.length > 5) return null;
  if (parts[0] !== CALLBACK_VERSION) return null;
  const [, panel, action, arg, nonce] = parts;
  if (panel === undefined || panel === "" || action === undefined || action === "") return null;
  return {
    panel,
    action,
    ...(arg !== undefined && arg !== "" ? { arg } : {}),
    ...(nonce !== undefined && nonce !== "" ? { nonce } : {}),
  };
}
