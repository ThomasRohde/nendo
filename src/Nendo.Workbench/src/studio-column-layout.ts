/** Only device layout preferences are stored, never AG Grid configuration or schema. */
export interface ColumnLayout { id: string; hidden: boolean; pinned: 'left' | 'right' | null }
export function columnLayoutKey(applicationId: string, entityId: string): string {
  return `nendo.studioLayout.${JSON.stringify([applicationId, entityId])}`;
}
export function cleanColumnLayout(value: unknown, allowed: readonly string[]): ColumnLayout[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 512).flatMap(item => {
    if (item === null || typeof item !== 'object' || !allowed.includes(item.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, hidden: item.hidden === true, pinned: item.pinned === 'left' || item.pinned === 'right' ? item.pinned : null }];
  });
}
export function readColumnLayout(storage: Pick<Storage, 'getItem'> | null, key: string, allowed: readonly string[]): ColumnLayout[] {
  try { return cleanColumnLayout(JSON.parse(storage?.getItem(key) ?? 'null'), allowed); } catch { return []; }
}
export function writeColumnLayout(storage: Pick<Storage, 'setItem'> | null, key: string, layout: ColumnLayout[]): void {
  try { storage?.setItem(key, JSON.stringify(layout)); } catch { /* Session layout still works. */ }
}
