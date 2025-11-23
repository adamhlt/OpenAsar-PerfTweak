const os = require("node:os");
const { app } = require("electron");
const { join } = require('path');

const TARGET = os.constants.priority.PRIORITY_NORMAL;

const hasOsGet = os && typeof os.getPriority === "function";
const hasOsSet = os && typeof os.setPriority === "function";
const hasProcGet = typeof process.getPriority === "function";
const hasProcSet = typeof process.setPriority === "function";

const getPrio = (pid) => {
  if (hasOsGet) return os.getPriority(pid);
  if (hasProcGet) return process.getPriority(pid);
  return NaN;
};

const setPrioNative = (pid, prio) => {
  if (hasOsSet) return os.setPriority(pid, prio);
  if (hasProcSet) return process.setPriority(pid, prio);
  throw new Error("No setPriority API available");
};

const INFO = "\x1b[36m", WARN = "\x1b[33m", ERR = "\x1b[31m", R = "\x1b[0m";
const seen = new Set();
const logI = (m)=>console.log(`${INFO}[OpenASAR Priority] ${m}${R}`);
const logW = (m)=>console.warn(`${WARN}[OpenASAR Priority] ${m}${R}`);
const logE = (m)=>console.error(`${ERR}[OpenASAR Priority] ${m}${R}`);

global.log = (area, ...args) => console.log(`[\x1b[38;2;88;101;242mOpenAsar\x1b[0m > ${area}]`, ...args); // Make log global for easy usage everywhere

global.oaVersion = 'nightly';

log('Init', 'OpenAsar', oaVersion);

if (process.resourcesPath.startsWith('/usr/lib/electron')) global.systemElectron = true; // Using system electron, flag for other places
process.resourcesPath = join(__dirname, '..'); // Force resourcesPath for system electron

const paths = require('./paths');
paths.init();

global.settings = require('./appSettings').getSettings();
global.oaConfig = settings.get('openasar', {});

require('./cmdSwitches')();

function applyPriority(pid) {
  try {
    if (!pid || pid <= 0) return;
    const cur = getPrio(pid);
    if (Number.isNaN(cur)) {
      setPrioNative(pid, TARGET);
      logI(`PID ${pid} → Priority set to ${TARGET} (no read API)`);
    } else if (cur !== TARGET) {
      setPrioNative(pid, TARGET);
      logI(`PID ${pid} → Priority changed (${cur} → ${TARGET})`);
    } else if (!seen.has(pid)) {
      logI(`PID ${pid} is already ${TARGET}`);
    }
    seen.add(pid);
  } catch (e) {
    logW(`Unable to change priority of PID ${pid}: ${e.message}`);
  }
}

try { applyPriority(process.pid); }
catch (e) { logE(`Error on main process: ${e.message}`); }

// Renderers, on creation
app.on("web-contents-created", (_evt, contents) => {
  const tryNow = () => {
    try {
      const pid = contents.getOSProcessId();
      if (pid > 0) { logI(`Renderer detected → PID ${pid}`); applyPriority(pid); return true; }
    } catch (e) { logW(`getOSProcessId() error: ${e.message}`); }
    return false;
  };
  if (!tryNow()) setTimeout(() => { if (!tryNow()) logW("Renderer not detected (PID=0 after retry)"); }, 250);
});

// Periodic sweep of all subprocesses (GPU/Utility/Network/etc.)
function sweepAll() {
  try {
    const metrics = typeof app.getAppMetrics === "function" ? app.getAppMetrics() : [];
    if (metrics.length === 0) return;
    logI(`Global sweep: ${metrics.length} processes detected`);
    for (const m of metrics) {
      if (!m || !m.pid) continue;
      if (!seen.has(m.pid)) logI(`New process "${m.type}" PID ${m.pid}`);
      applyPriority(m.pid);
    }
  } catch (e) {
    logW(`Error during sweepAll: ${e.message}`);
  }
}

app.whenReady().then(() => {
  logI("App ready → applying initial priorities...");
  applyPriority(process.pid);
  sweepAll();
  setInterval(sweepAll, 3000);
  logI(`Priority backend: get=[${hasOsGet?'os':'proc'}/${hasOsGet||hasProcGet? 'ok':'none'}], set=[${hasOsSet?'os':'proc'}/${hasOsSet||hasProcSet? 'ok':'none'}]`);
  logI("Automatic CPU priority management enabled!");
});

// Force u2QuickLoad (pre-"minified" ish)
const M = require('module'); // Module

const b = join(paths.getExeDir(), 'modules'); // Base dir
if (process.platform === 'win32') try {
  for (const m of require('fs').readdirSync(b)) M.globalPaths.unshift(join(b, m)); // For each module dir, add to globalPaths
} catch { log('Init', 'Failed to QS globalPaths') }

// inject Module.globalPaths into resolve lookups as it was removed in Electron >=17 and Discord depend on this workaround
const rlp = M._resolveLookupPaths;
M._resolveLookupPaths = (request, parent) => {
  if (parent?.paths?.length > 0) parent.paths = parent.paths.concat(M.globalPaths);
  return rlp(request, parent);
};

if (process.argv.includes('--overlay-host')) { // If overlay
  require('discord_overlay2/standalone_host.js'); // Start overlay
} else {
  require('./bootstrap')(); // Start bootstrap
}