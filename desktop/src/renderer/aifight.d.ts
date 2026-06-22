// The renderer reaches the main process ONLY through the preload-exposed
// `window.aifight`. This declares its type (the shared IPC contract) so the
// renderer is fully typed without importing any main/runtime source.

import type { AifightBridgeApi } from "../shared/ipc";

declare global {
  interface Window {
    readonly aifight: AifightBridgeApi;
  }
}

export {};
