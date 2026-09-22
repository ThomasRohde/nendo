import type { DesktopSessionView } from './host';
import { ideaGardenRecipe, type ApplicationRecipe } from './idea-garden-recipe';

const recipes = [ideaGardenRecipe];

export type { ApplicationRecipe };

export function applicationRecipeFor(session: DesktopSessionView): ApplicationRecipe | null {
  for (const recipe of recipes) {
    const candidate = recipe(session);
    if (candidate !== null) return candidate;
  }
  return null;
}
