import { z } from 'zod';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';

import { parseThemeProfilesLocalState, ThemeProfilesLocalStateSchema } from './themeProfilePersistence';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';

//
// The theme stays a per-device setting. The account only remembers the last
// selection made on any device, so a device that has no theme of its own (a
// fresh install, a browser that clears site data, or a logout) gets it back on
// sign-in instead of falling back to the default.
//

export type ThemeSelectionV1 = Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
}>;

export const AccountThemeSelectionV1Schema: z.ZodType<ThemeSelectionV1 | null> = z
    .object({
        themePreference: z.enum(['light', 'dark', 'adaptive']),
        themeProfiles: ThemeProfilesLocalStateSchema,
    })
    .nullable();

export type ThemeAccountSyncAction =
    | Readonly<{ kind: 'adopt'; selection: ThemeSelectionV1 }>
    | Readonly<{ kind: 'publish'; selection: ThemeSelectionV1 }>
    | null;

/** The account copy carries only the custom profiles the selection uses, not the whole local library. */
export const buildAccountThemeSelection = (local: ThemeSelectionV1): ThemeSelectionV1 => {
    const activeIds = new Set(Object.values(local.themeProfiles.activeProfileIds));
    return {
        themePreference: local.themePreference,
        themeProfiles: parseThemeProfilesLocalState({
            profiles: local.themeProfiles.profiles.filter((profile) => activeIds.has(profile.id)),
            activeProfileIds: local.themeProfiles.activeProfileIds,
        }).state,
    };
};

const isUnsetDeviceThemeSelection = (local: ThemeSelectionV1): boolean => (
    local.themePreference === 'adaptive'
    && local.themeProfiles.profiles.length === 0
    && local.themeProfiles.activeProfileIds.light === null
    && local.themeProfiles.activeProfileIds.dark === null
);

export const resolveThemeAccountSyncAction = (input: Readonly<{
    /** The local selection last observed, or null on first observation. */
    previousLocal: ThemeSelectionV1 | null;
    local: ThemeSelectionV1;
    account: ThemeSelectionV1 | null;
}>): ThemeAccountSyncAction => {
    const published = buildAccountThemeSelection(input.local);
    if (areAccountSettingsJsonValuesEqual(published, input.account)) return null;

    const localChanged = input.previousLocal !== null
        && !areAccountSettingsJsonValuesEqual(input.previousLocal, input.local);
    if (localChanged) return { kind: 'publish', selection: published };

    if (input.account === null) {
        // Backfill a theme chosen before the account could remember one.
        return isUnsetDeviceThemeSelection(input.local) ? null : { kind: 'publish', selection: published };
    }

    return isUnsetDeviceThemeSelection(input.local) ? { kind: 'adopt', selection: input.account } : null;
};
