import { state } from './app-state';
import { type ResolvedAppSetting, resolveSettings, settingValues } from './app-settings-model';

/** The settings a package of the open file declares, each resolved as the person sees it (ADR-0038). */
export function packageSettings(packageId: string): ResolvedAppSetting[] {
  const found = state.session.extensions?.packages.find(item => item.packageId === packageId);
  return found?.settings ? resolveSettings(found.settings, found.sharedSettings, found.personalSettings) : [];
}

/** What a view of the package reads: each setting's value by ID. */
export function packageSettingValues(packageId: string): Record<string, unknown> {
  return settingValues(packageSettings(packageId));
}
