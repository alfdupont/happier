/**
 * Browser Web Notifications API adapter. Plain browser tabs only; the Tauri desktop app uses
 * `tauriNotificationPlugin` and native apps use Expo notifications.
 */

export type WebNotificationPermission = 'granted' | 'default' | 'denied' | 'unsupported';

export type WebNotificationHandle = {
    onclick: (() => void) | null;
    close: () => void;
};

type WebNotificationConstructor = {
    readonly permission: NotificationPermission;
    requestPermission?: () => Promise<NotificationPermission>;
    new (title: string, options?: NotificationOptions): WebNotificationHandle;
};

function readWebNotificationConstructor(): WebNotificationConstructor | null {
    const candidate = (globalThis as unknown as { Notification?: unknown }).Notification;
    return typeof candidate === 'function' ? candidate as WebNotificationConstructor : null;
}

export function readWebNotificationPermission(): WebNotificationPermission {
    return readWebNotificationConstructor()?.permission ?? 'unsupported';
}

/** Must run from a user gesture: browsers ignore or auto-deny requests made outside one. */
export async function requestWebNotificationPermission(): Promise<WebNotificationPermission> {
    const NotificationCtor = readWebNotificationConstructor();
    if (!NotificationCtor) return 'unsupported';
    if (NotificationCtor.permission !== 'default' || typeof NotificationCtor.requestPermission !== 'function') {
        return NotificationCtor.permission;
    }
    return await NotificationCtor.requestPermission();
}

/** Returns null when the API is missing or permission is not granted. */
export function showWebNotification(title: string, options: NotificationOptions): WebNotificationHandle | null {
    const NotificationCtor = readWebNotificationConstructor();
    if (!NotificationCtor || NotificationCtor.permission !== 'granted') return null;
    return new NotificationCtor(title, options);
}
