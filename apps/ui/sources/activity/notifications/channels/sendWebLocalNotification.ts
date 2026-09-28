import { playWebNotificationChime } from './playWebNotificationChime';
import { showWebNotification } from './webNotificationApi';

/**
 * Shows a browser notification while the Happier tab is open. Permission is requested from
 * Settings → Notifications (it needs a user gesture); until it is granted this is a no-op.
 */
export async function sendWebLocalNotification(params: Readonly<{
    title: string;
    body: string;
    tag: string;
    playSound: boolean;
    onClick: () => void;
}>): Promise<boolean> {
    const notification = showWebNotification(params.title, {
        body: params.body,
        tag: params.tag,
        silent: true,
    });
    if (!notification) {
        return false;
    }

    notification.onclick = () => {
        (globalThis as unknown as { focus?: () => void }).focus?.();
        notification.close();
        params.onClick();
    };

    if (params.playSound) {
        await playWebNotificationChime();
    }
    return true;
}
