import { storage } from '@/sync/domains/state/storage';

import { readWebNotificationPermission } from './channels/webNotificationApi';

/**
 * Whether this browser tab is set up to show session notifications: device-local notifications
 * are enabled for at least one topic and the site holds notification permission.
 *
 * Sync reads this when the tab is hidden: browser notifications are raised from live session
 * events, so a tab that disconnects while hidden can never notify.
 */
export function isBrowserNotificationDeliveryEnabled(): boolean {
    const localSettings = storage.getState().localSettings;
    if (localSettings.localNotificationsEnabled === false) return false;

    const anyTopicEnabled = localSettings.localNotificationsShowReady !== false
        || localSettings.localNotificationsShowPendingPermissionRequests !== false
        || localSettings.localNotificationsShowPendingUserActionRequests !== false;
    if (!anyTopicEnabled) return false;

    return readWebNotificationPermission() === 'granted';
}
