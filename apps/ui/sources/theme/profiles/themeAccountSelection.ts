import { z } from 'zod';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';

import { ThemeProfileSelectionSchema, ThemeProfilesLocalStateSchema } from './themeProfilePersistence';
import type { ThemeProfileSelectionByMode, ThemeProfileStoredSelectionByMode, ThemeProfilesLocalStateV1 } from './themeProfileTypes';

//
// The theme stays a per-device setting. The account remembers the last
// selection made on any device as references into the canonical account
// library, so an unset device can restore it without a second profile store.
//

export type ThemeSelectionV1 = Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const AccountThemeProfilesSchema: z.ZodType<ThemeProfilesLocalStateV1> = z.unknown().transform((value) => {
    const parsed = ThemeProfilesLocalStateSchema.parse(value);
    if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length !== 0) return parsed;

    // New records carry references to the account library. Older V1 records
    // embed profile definitions and go through the legacy migration path.
    const stored = ThemeProfileSelectionSchema.parse(value.activeProfileIds);
    const activeProfileIds: ThemeProfileSelectionByMode = {
        light: typeof stored.light === 'string' ? stored.light : null,
        dark: typeof stored.dark === 'string' ? stored.dark : null,
    };
    return { ...parsed, activeProfileIds };
});

export const AccountThemeSelectionV1Schema: z.ZodType<ThemeSelectionV1 | null> = z
    .object({
        themePreference: z.enum(['light', 'dark', 'adaptive']),
        themeProfiles: AccountThemeProfilesSchema,
    })
    .nullable();

/** Remember IDs from the canonical account library, never a competing profile definition. */
export const buildAccountThemeSelection = (local: ThemeSelectionV1): ThemeSelectionV1 => {
    return {
        themePreference: local.themePreference,
        themeProfiles: {
            profiles: [],
            activeProfileIds: local.themeProfiles.activeProfileIds,
        },
    };
};

/** A remembered account selection applies only while this device still has its default theme state. */
export function isUnsetDeviceThemeSelection(local: Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    themeProfileSelection: ThemeProfileStoredSelectionByMode | null;
}>): boolean {
    const stored = local.themeProfileSelection;
    return local.themePreference === 'adaptive'
        && local.themeProfiles.profiles.length === 0
        && local.themeProfiles.activeProfileIds.light === null
        && local.themeProfiles.activeProfileIds.dark === null
        && (!stored || (stored.light === null && stored.dark === null));
}
