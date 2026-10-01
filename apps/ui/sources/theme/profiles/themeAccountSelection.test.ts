import { describe, expect, it } from 'vitest';

import {
    AccountThemeSelectionV1Schema,
    buildAccountThemeSelection,
    resolveThemeAccountSyncAction,
    type ThemeSelectionV1,
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

const unsetDevice: ThemeSelectionV1 = {
    themePreference: 'adaptive',
    themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
};

const mocha: ThemeSelectionV1 = {
    themePreference: 'dark',
    themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'catppuccinMocha' } },
};

const latte: ThemeSelectionV1 = {
    themePreference: 'light',
    themeProfiles: { profiles: [], activeProfileIds: { light: 'catppuccinLatte', dark: null } },
};

describe('buildAccountThemeSelection', () => {
    it('keeps only the custom profiles the selection actually uses', () => {
        const active = customProfile('mine-active');
        const selection = buildAccountThemeSelection({
            themePreference: 'dark',
            themeProfiles: {
                profiles: [customProfile('mine-unused'), active],
                activeProfileIds: { light: 'catppuccinLatte', dark: 'mine-active' },
            },
        });

        expect(selection).toEqual({
            themePreference: 'dark',
            themeProfiles: {
                profiles: [active],
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
});

describe('resolveThemeAccountSyncAction', () => {
    it('restores the account theme on a device that has no theme of its own', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: null, local: unsetDevice, account: mocha }))
            .toEqual({ kind: 'adopt', selection: mocha });
        expect(resolveThemeAccountSyncAction({ previousLocal: unsetDevice, local: unsetDevice, account: mocha }))
            .toEqual({ kind: 'adopt', selection: mocha });
    });

    it('restores custom profiles carried by the account theme', () => {
        const account: ThemeSelectionV1 = {
            themePreference: 'dark',
            themeProfiles: { profiles: [customProfile('mine')], activeProfileIds: { light: null, dark: 'mine' } },
        };

        expect(resolveThemeAccountSyncAction({ previousLocal: null, local: unsetDevice, account }))
            .toEqual({ kind: 'adopt', selection: account });
    });

    it('leaves a device that has its own theme alone when the account theme differs', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: latte, local: latte, account: mocha })).toBeNull();
    });

    it('does nothing when no device ever remembered a theme and this one has none', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: null, local: unsetDevice, account: null })).toBeNull();
    });

    it('remembers a theme chosen on this device', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: unsetDevice, local: latte, account: mocha }))
            .toEqual({ kind: 'publish', selection: latte });
    });

    it('remembers an explicit return to the default theme', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: mocha, local: unsetDevice, account: mocha }))
            .toEqual({ kind: 'publish', selection: unsetDevice });
    });

    it('does not echo a restored theme back to the account', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: unsetDevice, local: mocha, account: mocha })).toBeNull();
    });

    it('remembers a theme this device already had before the account could hold one', () => {
        expect(resolveThemeAccountSyncAction({ previousLocal: null, local: mocha, account: null }))
            .toEqual({ kind: 'publish', selection: mocha });
    });

    it('publishes only the custom profiles in use, and does not re-publish an equivalent selection', () => {
        const active = customProfile('mine');
        const local: ThemeSelectionV1 = {
            themePreference: 'dark',
            themeProfiles: { profiles: [customProfile('other'), active], activeProfileIds: { light: null, dark: 'mine' } },
        };
        const published: ThemeSelectionV1 = {
            themePreference: 'dark',
            themeProfiles: { profiles: [active], activeProfileIds: { light: null, dark: 'mine' } },
        };

        expect(resolveThemeAccountSyncAction({ previousLocal: unsetDevice, local, account: null }))
            .toEqual({ kind: 'publish', selection: published });
        expect(resolveThemeAccountSyncAction({ previousLocal: unsetDevice, local, account: published })).toBeNull();
    });
});
