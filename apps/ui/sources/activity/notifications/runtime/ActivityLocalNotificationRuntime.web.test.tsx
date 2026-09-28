import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import {
    createActivityNotificationTextModuleMock,
    installActivityNotificationRuntimeCommonModuleMocks,
} from './activityNotificationRuntimeTestHelpers';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Browser boundaries: the Web Notifications API, Web Audio, and the document focus/visibility state.
class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static instances: FakeNotification[] = [];
    onclick: (() => void) | null = null;
    closed = false;

    constructor(readonly title: string, readonly options: NotificationOptions) {
        FakeNotification.instances.push(this);
    }

    close(): void {
        this.closed = true;
    }
}

const audioOutput = vi.hoisted(() => ({ tonesStarted: 0 }));

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    createOscillator() {
        return {
            type: 'sine',
            frequency: { setValueAtTime: () => {} },
            connect: (target: unknown) => target,
            start: () => { audioOutput.tonesStarted += 1; },
            stop: () => {},
        };
    }
    createGain() {
        return {
            gain: {
                setValueAtTime: () => {},
                linearRampToValueAtTime: () => {},
                exponentialRampToValueAtTime: () => {},
            },
            connect: (target: unknown) => target,
        };
    }
}

type BrowserGlobals = {
    Notification?: unknown;
    AudioContext?: unknown;
    document?: unknown;
    focus?: unknown;
};
const browserGlobals = globalThis as unknown as BrowserGlobals;
const originalBrowserGlobals: BrowserGlobals = {
    Notification: browserGlobals.Notification,
    AudioContext: browserGlobals.AudioContext,
    document: browserGlobals.document,
    focus: browserGlobals.focus,
};

let documentState = { visibilityState: 'hidden', focused: false };
let activeViewingSessionIdValue: string | null = null;
let localSettingsValue: Partial<LocalSettings> = {};
const routerNavigate = vi.hoisted(() => vi.fn());

installActivityNotificationRuntimeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    text: async () => createActivityNotificationTextModuleMock(),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const useLocalSetting = <K extends keyof LocalSettings>(key: K): LocalSettings[K] => {
            return (localSettingsValue[key] ?? localSettingsDefaults[key]) as LocalSettings[K];
        };
        return createStorageModuleStub({
            useLocalSetting,
            storage: {
                getState: () => ({
                    sessions: {
                        'session-1': { id: 'session-1', metadata: { summary: { text: 'Ready session' } } },
                    },
                    localSettings: localSettingsValue,
                    settings: {},
                }),
            },
        });
    },
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { navigate: routerNavigate } }).module;
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    getActiveViewingSessionId: () => activeViewingSessionIdValue,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

async function renderRuntimeAndNotifyReady(
    sessionId = 'session-1',
    origin: 'transcript' | 'projection' = 'transcript',
): Promise<void> {
    const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
    const { notifyActivityReady } = await import('./activityLocalNotificationBus');

    const tree: renderer.ReactTestRenderer = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;
    await act(async () => {
        notifyActivityReady(sessionId, [], { origin });
    });
    await act(async () => {
        tree.unmount();
    });
}

describe('ActivityLocalNotificationRuntime (browser)', () => {
    beforeEach(() => {
        browserGlobals.Notification = FakeNotification;
        browserGlobals.AudioContext = FakeAudioContext;
        browserGlobals.focus = vi.fn();
        browserGlobals.document = {
            get visibilityState() { return documentState.visibilityState; },
            hasFocus: () => documentState.focused,
        };
    });

    afterEach(async () => {
        FakeNotification.permission = 'granted';
        FakeNotification.instances = [];
        audioOutput.tonesStarted = 0;
        documentState = { visibilityState: 'hidden', focused: false };
        activeViewingSessionIdValue = null;
        localSettingsValue = {};
        routerNavigate.mockReset();

        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
    });

    afterAll(() => {
        Object.assign(browserGlobals, originalBrowserGlobals);
    });

    it('shows a browser notification with sound when the open session finishes while the tab is in the background', async () => {
        activeViewingSessionIdValue = 'session-1';

        await renderRuntimeAndNotifyReady();

        expect(FakeNotification.instances).toHaveLength(1);
        expect(FakeNotification.instances[0]?.title).toBe('Ready session');
        expect(FakeNotification.instances[0]?.options.body).toBe('Turn finished. Open the session to continue.');
        expect(audioOutput.tonesStarted).toBeGreaterThan(0);
    });

    it('notifies for a hidden session whose ready turn only arrived as a session projection', async () => {
        documentState = { visibilityState: 'visible', focused: true };
        activeViewingSessionIdValue = 'session-2';

        await renderRuntimeAndNotifyReady('session-1', 'projection');

        expect(FakeNotification.instances).toHaveLength(1);
        expect(audioOutput.tonesStarted).toBeGreaterThan(0);
    });

    it('suppresses the notification while the tab is actively showing that session', async () => {
        documentState = { visibilityState: 'visible', focused: true };
        activeViewingSessionIdValue = 'session-1';

        await renderRuntimeAndNotifyReady();

        expect(FakeNotification.instances).toHaveLength(0);
        expect(audioOutput.tonesStarted).toBe(0);
    });

    it('shows a silent notification for another session when the foreground behavior is silent', async () => {
        documentState = { visibilityState: 'visible', focused: true };
        activeViewingSessionIdValue = 'session-2';
        localSettingsValue = { localNotificationsForegroundBehavior: 'silent' };

        await renderRuntimeAndNotifyReady();

        expect(FakeNotification.instances).toHaveLength(1);
        expect(audioOutput.tonesStarted).toBe(0);
    });

    it('shows nothing for another session when the foreground behavior is off', async () => {
        documentState = { visibilityState: 'visible', focused: true };
        activeViewingSessionIdValue = 'session-2';
        localSettingsValue = { localNotificationsForegroundBehavior: 'off' };

        await renderRuntimeAndNotifyReady();

        expect(FakeNotification.instances).toHaveLength(0);
        expect(audioOutput.tonesStarted).toBe(0);
    });

    it('stays quiet until the browser grants notification permission', async () => {
        FakeNotification.permission = 'default';

        await renderRuntimeAndNotifyReady();

        expect(FakeNotification.instances).toHaveLength(0);
        expect(audioOutput.tonesStarted).toBe(0);
    });

    it('opens the session when the notification is clicked', async () => {
        await renderRuntimeAndNotifyReady();

        const notification = FakeNotification.instances[0];
        expect(notification).toBeTruthy();
        act(() => {
            notification?.onclick?.();
        });

        expect(browserGlobals.focus).toHaveBeenCalled();
        expect(notification?.closed).toBe(true);
        expect(routerNavigate).toHaveBeenCalledWith(
            expect.stringContaining('session-1'),
            expect.anything(),
        );
    });
});
