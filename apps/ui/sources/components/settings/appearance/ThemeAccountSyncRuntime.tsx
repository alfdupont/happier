import * as React from 'react';
import { Appearance } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useLocalSetting, useSetting } from '@/sync/store/hooks';
import { applyLocalSettingsFromSyncPull, applySystemSettings } from '@/sync/store/settingsWriters';
import { resolveThemeAccountSyncAction, type ThemeSelectionV1 } from '@/theme/profiles/themeAccountSelection';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';

/**
 * Keeps the account's remembered theme in step with this device: a theme picked here is
 * remembered on the account, and a device without a theme of its own adopts the remembered one.
 */
export function ThemeAccountSyncRuntime() {
    const { isAuthenticated } = useAuth();
    const themePreference = useLocalSetting('themePreference');
    const themeProfiles = useLocalSetting('themeProfiles');
    const account = useSetting('appearanceThemeSelectionV1');
    const previousLocalRef = React.useRef<ThemeSelectionV1 | null>(null);

    React.useEffect(() => {
        const local: ThemeSelectionV1 = { themePreference, themeProfiles };
        const previousLocal = previousLocalRef.current;
        // Track changes while signed out too, so they are not mistaken for new picks after sign-in.
        previousLocalRef.current = local;
        if (!isAuthenticated) return;

        const action = resolveThemeAccountSyncAction({ previousLocal, local, account });
        if (action?.kind === 'publish') {
            applySystemSettings({ appearanceThemeSelectionV1: action.selection });
        } else if (action?.kind === 'adopt') {
            const { selection } = action;
            const systemTheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
            applyLocalSettingsFromSyncPull({
                themePreference: selection.themePreference,
                themeProfiles: selection.themeProfiles,
            });
            applyThemeRuntimeSelection({
                themePreference: selection.themePreference,
                themeProfiles: selection.themeProfiles,
                systemTheme,
            });
            setStatusBarStyle(resolveStatusBarStyleForThemePreference(selection.themePreference, systemTheme), true);
        }
    }, [account, isAuthenticated, themePreference, themeProfiles]);

    return null;
}
