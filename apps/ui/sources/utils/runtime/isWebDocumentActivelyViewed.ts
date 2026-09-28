/**
 * Web runtimes only (browser tab or Tauri webview): whether the document is visible and focused,
 * i.e. the user is looking at it right now. Unlike `isRuntimeActive`, a visible window sitting
 * behind another app does not count.
 */
export function isWebDocumentActivelyViewed(): boolean {
    const doc = (globalThis as unknown as {
        document?: {
            visibilityState?: string;
            hasFocus?: () => boolean;
        };
    }).document;

    if (doc?.visibilityState === 'hidden') {
        return false;
    }

    if (typeof doc?.hasFocus === 'function') {
        return doc.hasFocus();
    }

    return true;
}
