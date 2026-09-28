import * as React from 'react';
import { Platform } from 'react-native';

import {
    isPermissionGranted as isTauriPermissionGranted,
    requestPermission as requestTauriPermission,
} from '@/activity/notifications/channels/tauriNotificationPlugin';
import {
    readWebNotificationPermission,
    requestWebNotificationPermission,
    type WebNotificationPermission,
} from '@/activity/notifications/channels/webNotificationApi';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { primeWebAudioPlayback } from '@/voice/output/webAudioContext';

/** Where device-local notifications are shown on web runtimes; native uses push permission instead. */
export type DeviceNotificationSurface = 'desktop' | 'browser';

export type DeviceNotificationPermissionStatus =
    | 'checking'
    | 'granted'
    | 'notGranted'
    | 'blocked'
    | 'unsupported'
    | 'error';

export function resolveDeviceNotificationSurface(): DeviceNotificationSurface | null {
    if (isTauriDesktop()) return 'desktop';
    return Platform.OS === 'web' ? 'browser' : null;
}

function toStatusFromWebPermission(permission: WebNotificationPermission): DeviceNotificationPermissionStatus {
    switch (permission) {
        case 'granted':
            return 'granted';
        case 'denied':
            return 'blocked';
        case 'unsupported':
            return 'unsupported';
        case 'default':
        default:
            return 'notGranted';
    }
}

const permissionAdapters: Record<DeviceNotificationSurface, Readonly<{
    read: () => Promise<DeviceNotificationPermissionStatus>;
    request: () => Promise<DeviceNotificationPermissionStatus>;
}>> = {
    desktop: {
        read: async () => (await isTauriPermissionGranted()) ? 'granted' : 'notGranted',
        request: async () => (await requestTauriPermission()) === 'granted' ? 'granted' : 'notGranted',
    },
    browser: {
        read: async () => toStatusFromWebPermission(readWebNotificationPermission()),
        request: async () => {
            // Same gesture unlocks Web Audio so the notification chime can play later.
            primeWebAudioPlayback();
            return toStatusFromWebPermission(await requestWebNotificationPermission());
        },
    },
};

export function useDeviceNotificationPermission(surface: DeviceNotificationSurface | null): Readonly<{
    status: DeviceNotificationPermissionStatus;
    requestPermission: () => Promise<void>;
}> {
    const [status, setStatus] = React.useState<DeviceNotificationPermissionStatus>(
        surface ? 'checking' : 'unsupported',
    );

    const refresh = React.useCallback(async () => {
        if (!surface) {
            setStatus('unsupported');
            return;
        }

        setStatus('checking');
        try {
            setStatus(await permissionAdapters[surface].read());
        } catch {
            setStatus('error');
        }
    }, [surface]);

    React.useEffect(() => {
        let cancelled = false;

        const run = async () => {
            if (!surface) {
                setStatus('unsupported');
                return;
            }

            setStatus('checking');
            try {
                const next = await permissionAdapters[surface].read();
                if (!cancelled) {
                    setStatus(next);
                }
            } catch {
                if (!cancelled) {
                    setStatus('error');
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, [surface]);

    const requestPermission = React.useCallback(async () => {
        if (!surface) {
            setStatus('unsupported');
            return;
        }

        setStatus('checking');
        try {
            setStatus(await permissionAdapters[surface].request());
        } catch {
            setStatus('error');
            return;
        }

        await refresh();
    }, [surface, refresh]);

    return {
        status,
        requestPermission,
    };
}
