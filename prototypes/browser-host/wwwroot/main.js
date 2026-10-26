import { dotnet } from './_framework/dotnet.js';

const started = performance.now();
const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
const answer = exports.Host.Invoke(JSON.stringify({ method: 'session.getSnapshot' }));
document.getElementById('out').textContent = `${answer}\nstartMs=${Math.round(performance.now() - started)}`;
window.nendoProbe = { answer: JSON.parse(answer), startMs: Math.round(performance.now() - started) };
