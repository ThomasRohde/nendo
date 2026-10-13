// Types for third-party-notices.mjs, which vite.config.ts imports.
export interface ProductionPackage { name: string; version: string; license: string; path: string }
export function productionPackages(workbenchRoot: string): ProductionPackage[];
export function thirdPartyNotices(workbenchRoot: string | URL): string;
export function missingNotices(workbenchRoot: string, text: string): string[];
