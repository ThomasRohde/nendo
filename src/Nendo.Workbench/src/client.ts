import { createWorkbenchClient } from './host';

/**
 * The one bridge to the host, created once for the lifetime of the renderer.
 *
 * It lives alone rather than in the shell so that a module needing to make a
 * request does not also pull in the shell's element lookups, which run against
 * the document the moment they are imported.
 */
export const client = createWorkbenchClient();
