// The product version, read from the repository's build props at build time so the
// site cannot drift from what the installer ships.
import props from '../../Directory.Build.props?raw';

const match = props.match(/<Version>([^<]+)<\/Version>/);
if (!match) throw new Error('Directory.Build.props has no <Version>.');

export const version = match[1];
