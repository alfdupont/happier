import { router } from 'expo-router';
import * as React from 'react';

import { Platform } from 'react-native';

import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { isWebDocumentActivelyViewed } from '@/utils/runtime/isWebDocumentActivelyViewed';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityLocalNotificationContent } from '../buildActivityLocalNotificationContent';
import { sendExpoLocalNotification } from '../channels/sendExpoLocalNotification';
import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';
import { sendWebLocalNotification } from '../channels/sendWebLocalNotification';
import { resolveForegroundNotificationBehavior } from '../resolveForegroundNotificationBehavior';
import { subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';

type ActivityLocalNotificationSettings = Readonly<{
    localNotificationsEnabled: boolean;
    localNotificationsShowReady: boolean;
    localNotificationsShowReadyMessageText: boolean;
    localNotificationsShowRequestMessageText: boolean;
    localNotificationsShowPendingPermissionRequests: boolean;
    localNotificationsShowPendingUserActionRequests: boolean;
}>;

function useActivityLocalNotificationSettings(): ActivityLocalNotificationSettings {
    const localNotificationsEnabled = useLocalSetting('localNotificationsEnabled');
    const localNotificationsShowReady = useLocalSetting('localNotificationsShowReady');
    const localNotificationsShowReadyMessageText = useLocalSetting('localNotificationsShowReadyMessageText');
    const localNotificationsShowRequestMessageText = useLocalSetting('localNotificationsShowRequestMessageText');
    const localNotificationsShowPendingPermissionRequests = useLocalSetting('localNotificationsShowPendingPermissionRequests');
    const localNotificationsShowPendingUserActionRequests = useLocalSetting('localNotificationsShowPendingUserActionRequests');

    return React.useMemo(
        () => ({
            localNotificationsEnabled,
            localNotificationsShowReady,
            localNotificationsShowReadyMessageText,
            localNotificationsShowRequestMessageText,
            localNotificationsShowPendingPermissionRequests,
            localNotificationsShowPendingUserActionRequests,
        }),
        [
            localNotificationsEnabled,
            localNotificationsShowPendingPermissionRequests,
            localNotificationsShowPendingUserActionRequests,
            localNotificationsShowReady,
            localNotificationsShowReadyMessageText,
            localNotificationsShowRequestMessageText,
        ],
    );
}

function shouldNotifyForEvent(
    localSettings: ActivityLocalNotificationSettings,
    event: ActivityLocalNotificationEvent,
): boolean {
    if (localSettings.localNotificationsEnabled === false) {
        return false;
    }

    if (event.kind === 'ready') {
        return localSettings.localNotificationsShowReady !== false;
    }

    if (event.requestKind === 'permission') {
        return localSettings.localNotificationsShowPendingPermissionRequests !== false;
    }

    return localSettings.localNotificationsShowPendingUserActionRequests !== false;
}

function shouldSuppressSameSessionNotification(event: ActivityLocalNotificationEvent): boolean {
    if (getActiveViewingSessionId() !== event.sessionId) {
        return false;
    }

    if (Platform.OS !== 'web') {
        return true;
    }

    // Browser tab or desktop window: only suppress while the user is actually looking at it.
    return isWebDocumentActivelyViewed();
}

function sendBrowserNotification(
    event: ActivityLocalNotificationEvent,
    notification: Readonly<{ title: string; body: string }>,
): void {
    // In the background the notification always sounds, like an OS push. While the tab is in
    // front, the foreground behavior decides, as it does for native in-app presentation.
    const foregroundBehavior = isWebDocumentActivelyViewed()
        ? resolveForegroundNotificationBehavior({
            localSettings: storage.getState().localSettings,
            accountSettings: storage.getState().settings,
        })
        : 'full';
    if (foregroundBehavior === 'off') {
        return;
    }

    fireAndForget(sendWebLocalNotification({
        title: notification.title,
        body: notification.body,
        tag: event.kind === 'ready' ? `happier-ready-${event.sessionId}` : `happier-request-${event.requestId}`,
        playSound: foregroundBehavior === 'full',
        onClick: () => navigateToSessionRoute({ router, sessionId: event.sessionId }),
    }), { tag: 'ActivityLocalNotificationRuntime.sendWebLocalNotification' });
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    const localSettings = useActivityLocalNotificationSettings();

    React.useEffect(() => {
        return subscribeActivityLocalNotifications((event) => {
            if (!shouldNotifyForEvent(localSettings, event)) {
                return;
            }

            // Native apps receive the push notification for a hidden session's ready turn; only
            // web runtimes (browser and desktop) have no push and rely on the projection signal.
            if (event.kind === 'ready' && event.origin === 'projection' && Platform.OS !== 'web') {
                return;
            }

            if (shouldSuppressSameSessionNotification(event)) {
                return;
            }

            const session = storage.getState().sessions[event.sessionId];
            const notification = buildActivityLocalNotificationContent({
                event,
                session,
                serverUrl: getActiveServerUrl(),
                includeReadyMessageText: localSettings.localNotificationsShowReadyMessageText !== false,
                includeRequestMessageText: localSettings.localNotificationsShowRequestMessageText !== false,
            });

            if (isTauriDesktop()) {
                fireAndForget(sendTauriLocalNotification({
                    title: notification.title,
                    body: notification.body,
                }), { tag: 'ActivityLocalNotificationRuntime.sendTauriLocalNotification' });
                return;
            }

            if (Platform.OS === 'web') {
                sendBrowserNotification(event, notification);
                return;
            }

            fireAndForget(sendExpoLocalNotification({
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
            }), { tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification' });
        });
    }, [localSettings]);

    return null;
}
