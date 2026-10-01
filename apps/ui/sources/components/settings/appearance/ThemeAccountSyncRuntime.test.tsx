import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThemeSelectionV1 } from '@/theme/profiles/themeAccountSelection';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    isAuthenticated: true,
    local: null as unknown as ThemeSelectionV1,
    account: null as ThemeSelectionV1 | null,
    applySystemSettings: vi.fn(),
    applyLocalSettingsFromSyncPull: vi.fn(),
    applyThemeRuntimeSelection: vi.fn(),
    setStatusBarStyle: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Appearance: { getColorScheme: () => 'dark' },
    });
});

vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: shared.isAuthenticated }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: 'themePreference' | 'themeProfiles') => shared.local[key],
    useSetting: (key: string) => (key === 'appearanceThemeSelectionV1' ? shared.account : undefined),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    applySystemSettings: shared.applySystemSettings,
    applyLocalSettingsFromSyncPull: shared.applyLocalSettingsFromSyncPull,
}));

vi.mock('@/theme/profiles/themeProfileRuntime', () => ({
    applyThemeRuntimeSelection: shared.applyThemeRuntimeSelection,
}));

import { ThemeAccountSyncRuntime } from './ThemeAccountSyncRuntime';

const unsetDevice: ThemeSelectionV1 = {
    themePreference: 'adaptive',
    themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
};

const mocha: ThemeSelectionV1 = {
    themePreference: 'dark',
    themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'catppuccinMocha' } },
};

describe('ThemeAccountSyncRuntime', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    const render = () => {
        act(() => {
            tree = renderer.create(<ThemeAccountSyncRuntime />);
        });
    };

    const rerender = () => {
        act(() => {
            tree!.update(<ThemeAccountSyncRuntime />);
        });
    };

    beforeEach(() => {
        shared.isAuthenticated = true;
        shared.local = unsetDevice;
        shared.account = null;
        vi.clearAllMocks();
    });

    afterEach(() => {
        act(() => tree?.unmount());
        tree = null;
    });

    it('restores the account theme once the signed-in account settings arrive on a device without a theme', () => {
        render();
        expect(shared.applyLocalSettingsFromSyncPull).not.toHaveBeenCalled();

        shared.account = mocha;
        rerender();

        expect(shared.applyLocalSettingsFromSyncPull).toHaveBeenCalledWith({
            themePreference: 'dark',
            themeProfiles: mocha.themeProfiles,
        });
        expect(shared.applyThemeRuntimeSelection).toHaveBeenCalledWith({
            themePreference: 'dark',
            themeProfiles: mocha.themeProfiles,
            systemTheme: 'dark',
        });
        expect(shared.setStatusBarStyle).toHaveBeenCalledWith('light', true);

        // The restored theme lands in local settings; it must not be echoed back.
        shared.local = mocha;
        rerender();
        expect(shared.applySystemSettings).not.toHaveBeenCalled();
    });

    it('remembers a theme the user picks on this device', () => {
        render();

        shared.local = mocha;
        rerender();

        expect(shared.applySystemSettings).toHaveBeenCalledWith({ appearanceThemeSelectionV1: mocha });
        expect(shared.applyLocalSettingsFromSyncPull).not.toHaveBeenCalled();
    });

    it('neither restores nor remembers while signed out', () => {
        shared.isAuthenticated = false;
        shared.account = mocha;
        render();

        shared.local = { ...mocha, themePreference: 'light' };
        rerender();

        expect(shared.applyLocalSettingsFromSyncPull).not.toHaveBeenCalled();
        expect(shared.applySystemSettings).not.toHaveBeenCalled();
    });
});
