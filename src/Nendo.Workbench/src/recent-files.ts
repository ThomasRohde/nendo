/** What a recent file's state means to the person, not the host's word for it (WMX-15). */
export function recentFileState(state: string): string {
  switch (state) {
    case 'available': return 'Open';
    case 'missing': return 'Moved or deleted. Use Open Nendo file to find it';
    case 'changed': return 'A different file is at this path now';
    case 'unavailable': return 'Cannot be read right now';
    default: return 'Cannot be opened';
  }
}
