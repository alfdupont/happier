import * as React from 'react';
import { Appearance, Platform } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { resolveStatusBarStyleForThemePreference, type ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { storage } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ThemeProfileView } from '@/sync/domains/settings/themeProfiles';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { buildAccountThemeSelection } from '@/theme/profiles/themeAccountSelection';
import { runThemePreferenceChange } from './themePreferenceTransition';

/**
 * Commit a user theme selection: the device's local selection, the account's remembered
 * selection, and the live runtime. Every theme-selection surface funnels through here so
 * remembering cannot be bypassed. Resolves with the accepted library view so a caller can
 * re-anchor navigation on the identities the account actually stored.
 */
export type ApplyThemeSelection = (
    nextThemePreference: ThemePreference,
    nextThemeProfiles: ThemeProfilesLocalStateV1,
) => Promise<ThemeProfileView | undefined>;

export function useApplyThemeSelection(input: Readonly<{
    themePreference: ThemePreference;
    setThemePreference: (value: ThemePreference) => void;
    setThemeProfiles: (value: ThemeProfilesLocalStateV1) => ThemeProfileView;
    applyAccountSettings: (delta: Partial<Settings>) => void;
    reduceMotion: boolean;
}>): ApplyThemeSelection {
    const { themePreference, setThemePreference, setThemeProfiles, applyAccountSettings, reduceMotion } = input;
    return React.useCallback(async (nextThemePreference: ThemePreference, nextThemeProfiles: ThemeProfilesLocalStateV1) => {
        const systemTheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        let accepted: ThemeProfileView | undefined;
        await runThemePreferenceChange({
            currentPreference: themePreference,
            nextPreference: nextThemePreference,
            platform: Platform.OS,
            reduceMotion,
            forceAnimate: true,
            systemTheme,
            mutation: () => {
                const written = setThemeProfiles(nextThemeProfiles);
                accepted = written;
                setThemePreference(nextThemePreference);
                if (storage.getState().settingsScope) {
                    applyAccountSettings({
                        appearanceThemeSelectionV1: buildAccountThemeSelection({
                            themePreference: nextThemePreference,
                            themeProfiles: accepted.state,
                        }),
                    });
                }
                applyThemeRuntimeSelection({
                    themePreference: nextThemePreference,
                    themeProfiles: written.state,
                    systemTheme,
                });
                setStatusBarStyle(resolveStatusBarStyleForThemePreference(nextThemePreference, systemTheme), true);
            },
        });
        return accepted;
    }, [applyAccountSettings, reduceMotion, setThemePreference, setThemeProfiles, themePreference]);
}
