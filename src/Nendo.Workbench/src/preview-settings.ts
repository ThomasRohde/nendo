import type { SettingDescriptor, SettingsView } from './host-types';

/**
 * The preview's answer to `settings.describe`: the host's settings catalogue
 * (src/Nendo.Session/SettingsCatalogue.cs) as the Windows host offers it, so the Settings page
 * draws in the preview as it does in Nendo. settings-model.test.mjs holds the two to the same IDs.
 */
const row = (id: string, section: SettingDescriptor['section'], group: string, title: string, help: string | null,
  home: SettingDescriptor['home'], kind: SettingDescriptor['kind'], store: string, extra: Partial<SettingDescriptor> = {}): SettingDescriptor => ({
  id, section, group, title, help, home, kind, store, options: null, minimum: null, maximum: null, unit: null, windowsOnly: false, needsFile: false, ...extra,
});

export const previewCatalogue: readonly SettingDescriptor[] = [
  row('appearance.theme', 'general', 'Appearance', 'Theme', 'System follows Windows.', 'device', 'choice', 'window\\appearance.json',
    { options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] }),
  row('appearance.shortcutHints', 'general', 'Appearance', 'Show shortcut hints', 'Key names beside the commands that have them. Ctrl / switches them too.', 'device', 'toggle', 'page storage: nendo.shortcuts'),
  row('window.closeToTray', 'general', 'Window', 'Close keeps Nendo in the notification area', 'Agents stay connected while the window is closed. Off: Close ends Nendo.', 'device', 'toggle', 'window\\tray.json', { windowsOnly: true }),
  row('media.webPictures', 'general', 'Pictures', 'Load pictures from the web', 'A picture field that links to an address shows the picture from there.', 'device', 'toggle', 'page storage: nendo.media.webPictures'),
  row('diagnostics.recordFailures', 'general', 'Diagnostics', 'Record failures', 'Keeps the last 50 times a view stopped or an agent request failed inside Nendo, on this computer.', 'device', 'toggle', 'window\\tray.json', { windowsOnly: true }),
  row('agents.access', 'agents', 'This file', 'Agent access', 'What an agent connected to this file may do.', 'here', 'choice', 'agents\\access.json',
    { options: [{ value: 'off', label: 'Off' }, { value: 'inspect', label: 'Inspect' }, { value: 'editData', label: 'Edit data' }, { value: 'shapeApp', label: 'Shape app' }, { value: 'unattended', label: 'Unattended' }], windowsOnly: true, needsFile: true }),
  row('agents.port', 'agents', 'This file', 'Port for this file', 'Used while each file keeps its port.', 'here', 'number', 'agents\\ports.json', { minimum: 1024, maximum: 65535, windowsOnly: true, needsFile: true }),
  row('agents.startInRepository', 'agents', 'This file', 'Start agents in the file\'s repository', 'Off: a launched agent starts in an empty folder of its own.', 'here', 'toggle', 'agents\\launch.json', { windowsOnly: true, needsFile: true }),
  row('agents.fixedPort', 'agents', 'Connection', 'Each file keeps its port', 'Off: a free port each time agent access starts.', 'device', 'toggle', 'agents\\connection.json', { windowsOnly: true }),
  row('agents.leaseExpiry', 'agents', 'Connection', 'End an idle edit lease', 'An agent that stops writing gives up editing after the time below.', 'device', 'toggle', 'agents\\connection.json', { windowsOnly: true }),
  row('agents.leaseExpirySeconds', 'agents', 'Connection', 'Idle time before a lease ends', null, 'device', 'number', 'agents\\connection.json', { minimum: 15, maximum: 86400, unit: 'seconds', windowsOnly: true }),
  row('agents.viewMessages', 'agents', 'Launching', 'Views may message the agent', 'Ask shows a card the first time a view sends a message in a conversation.', 'device', 'choice', 'agents\\launch.json',
    { options: [{ value: 'never', label: 'Never' }, { value: 'ask', label: 'Ask' }, { value: 'always', label: 'Always' }], windowsOnly: true }),
  row('agents.options', 'agents', 'Launching', 'Each agent\'s settings', 'Model, mode and the other options an agent offers, kept from its last launch. Set them on the Agent page while it runs.', 'device', 'link', 'agents\\settings.json', { windowsOnly: true }),
  row('views.run', 'views', 'Run', 'Run custom views', 'Off: every file opens without its views. Studio and your data stay.', 'device', 'toggle', 'views\\settings.json'),
  row('views.runThisFile', 'views', 'Run', 'Run this file\'s views', null, 'here', 'toggle', 'views\\settings.json', { needsFile: true }),
  row('views.developmentLinks', 'views', 'Development', 'Development links', 'Run a package from a folder instead of the copy in the file. Set in Studio, on Custom views.', 'here', 'link', 'views\\settings.json', { windowsOnly: true, needsFile: true }),
  row('file.look', 'file', 'Identity', 'Look', 'The icon on the taskbar, in Alt+Tab and on notifications.', 'file', 'link', 'definition: application.setLook', { needsFile: true }),
  row('file.purpose', 'file', 'Identity', 'Purpose', 'What the file is for, in a sentence agents and Help read first.', 'file', 'text', 'definition: application.setPurpose', { maximum: 4000, needsFile: true }),
  row('file.newFileLabel', 'file', 'Identity', 'Name for a new file', 'What File → New calls one more file of this application.', 'file', 'text', 'definition: application.setNewFileLabel', { maximum: 40, needsFile: true }),
  row('file.icons', 'file', 'Icons', 'Icons', 'The icon of each record type and screen in the navigation. Right-click one there to change it too.', 'file', 'icons', 'definition: schema.setEntityIcon and a screen\'s icon', { needsFile: true }),
  row('file.automaticActions', 'file', 'Automatic actions', 'Automatic actions', 'Whether this file\'s automatic actions may run on this computer. A copy you send asks again.', 'here', 'action', 'actions\\consent.json', { needsFile: true }),
];

/** The catalogue with the two values only the host reads. */
export function previewSettings(shell: { closeToTray: boolean; recordFailures: boolean }): SettingsView {
  return { settings: previewCatalogue.map(setting => ({ setting, override: null,
    value: setting.id === 'window.closeToTray' ? shell.closeToTray : setting.id === 'diagnostics.recordFailures' ? shell.recordFailures : null })) };
}
