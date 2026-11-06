import { describe, expect, it } from 'vitest';

import {
    AccountThemeSelectionV1Schema,
    buildAccountThemeSelection,
    isUnsetDeviceThemeSelection,
} from './themeAccountSelection';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from './themeProfilePersistence';
import type { ThemeProfileV1 } from './themeProfileTypes';

const customProfile = (id: string): ThemeProfileV1 => ({
    schemaVersion: 1,
    id,
    name: `Profile ${id}`,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    assetAppearance: 'dark',
    overrides: { light: {}, dark: {} },
});

describe('buildAccountThemeSelection', () => {
    it('stores canonical profile references without carrying a second profile library', () => {
        const selection = buildAccountThemeSelection({
            themePreference: 'dark',
            themeProfiles: {
                profiles: [customProfile('mine-unused'), customProfile('mine-active')],
                activeProfileIds: { light: 'catppuccinLatte', dark: 'mine-active' },
            },
        });

        expect(selection).toEqual({
            themePreference: 'dark',
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: 'catppuccinLatte', dark: 'mine-active' },
            },
        });
    });
});

describe('AccountThemeSelectionV1Schema', () => {
    it('defaults to nothing remembered and sanitizes what the account carries', () => {
        expect(AccountThemeSelectionV1Schema.parse(null)).toBeNull();
        expect(AccountThemeSelectionV1Schema.safeParse({ themePreference: 'neon', themeProfiles: {} }).success).toBe(false);
        expect(AccountThemeSelectionV1Schema.parse({
            themePreference: 'dark',
            themeProfiles: { profiles: [{ id: 'garbage' }], activeProfileIds: { light: null, dark: 'not-a-theme' } },
        })).toEqual({
            themePreference: 'dark',
            themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
        });
    });

    it('preserves canonical profile IDs after their embedded definitions have been consumed', () => {
        expect(AccountThemeSelectionV1Schema.parse({
            themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'account-profile' } },
        })).toEqual({
            themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'account-profile' } },
        });
    });
});

describe('isUnsetDeviceThemeSelection', () => {
    const unset = {
        themePreference: 'adaptive' as const,
        themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
        themeProfileSelection: null,
    };

    it('recognizes a device that has not selected a theme', () => {
        expect(isUnsetDeviceThemeSelection(unset)).toBe(true);
    });

    it('preserves an explicit preference or active account profile on the device', () => {
        expect(isUnsetDeviceThemeSelection({ ...unset, themePreference: 'light' })).toBe(false);
        expect(isUnsetDeviceThemeSelection({ ...unset, themeProfileSelection: { light: null, dark: 'catppuccinMocha' } })).toBe(false);
    });

    it('preserves the older local profile library as a migration source', () => {
        expect(isUnsetDeviceThemeSelection({ ...unset, themeProfiles: {
            profiles: [customProfile('device')], activeProfileIds: { light: null, dark: null },
        } })).toBe(false);
    });
});
