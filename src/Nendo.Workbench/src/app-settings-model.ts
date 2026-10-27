/**
 * The settings an app declares in its package (ADR-0038), and how a value is found: the app's
 * default, then the file's shared value where the setting allows one, then this computer's
 * personal value where it allows one. A value that no longer fits its declaration is passed over,
 * so a stored value from an older declaration never reaches a view. Pure, so the Settings page,
 * the broker and a test share it.
 */

export type AppSettingType = 'toggle' | 'choice' | 'number' | 'text';
export type AppSettingLayers = 'personal' | 'shared' | 'both';

export interface AppSettingDeclaration {
  id: string;
  title: string;
  help: string | null;
  type: AppSettingType;
  default: unknown;
  layers: AppSettingLayers;
  options: { value: string; label: string }[] | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  maxLength: number | null;
}

/** Where the value a view sees came from. */
export type AppSettingSource = 'default' | 'file' | 'personal';

export interface ResolvedAppSetting {
  declaration: AppSettingDeclaration;
  value: unknown;
  source: AppSettingSource;
  /** The file's value, when one is kept and fits. */
  shared: unknown;
  /** This computer's value, when one is kept and fits. */
  personal: unknown;
}

export function allowsShared(declaration: AppSettingDeclaration): boolean {
  return declaration.layers === 'shared' || declaration.layers === 'both';
}

export function allowsPersonal(declaration: AppSettingDeclaration): boolean {
  return declaration.layers === 'personal' || declaration.layers === 'both';
}

/** Whether a value is one this declaration takes. */
export function fits(declaration: AppSettingDeclaration, value: unknown): boolean {
  switch (declaration.type) {
    case 'toggle': return typeof value === 'boolean';
    case 'choice': return typeof value === 'string' && (declaration.options ?? []).some(option => option.value === value);
    case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (declaration.min === null || value >= declaration.min) && (declaration.max === null || value <= declaration.max);
    case 'text': return typeof value === 'string' && value.length <= (declaration.maxLength ?? 1000);
  }
}

const has = (values: Record<string, unknown> | null | undefined, id: string): boolean =>
  values !== null && values !== undefined && Object.prototype.hasOwnProperty.call(values, id);

export function resolveSettings(declarations: readonly AppSettingDeclaration[], shared: Record<string, unknown> | null | undefined,
  personal: Record<string, unknown> | null | undefined): ResolvedAppSetting[] {
  return declarations.map(declaration => {
    const fileValue = allowsShared(declaration) && has(shared, declaration.id) && fits(declaration, shared![declaration.id]) ? shared![declaration.id] : undefined;
    const ownValue = allowsPersonal(declaration) && has(personal, declaration.id) && fits(declaration, personal![declaration.id]) ? personal![declaration.id] : undefined;
    const value = ownValue !== undefined ? ownValue : fileValue !== undefined ? fileValue : declaration.default;
    const source: AppSettingSource = ownValue !== undefined ? 'personal' : fileValue !== undefined ? 'file' : 'default';
    return { declaration, value, source, shared: fileValue, personal: ownValue };
  });
}

/** What a view reads: each setting's value by ID. */
export function settingValues(resolved: readonly ResolvedAppSetting[]): Record<string, unknown> {
  return Object.fromEntries(resolved.map(item => [item.declaration.id, item.value]));
}
