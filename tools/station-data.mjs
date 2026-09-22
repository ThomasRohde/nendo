// The Nendo Station dataset. Small enough to read, large enough for the charts
// to mean something. See docs/design/nendo-station-plan.md.
//
// Dates are generated relative to the day the station is built, not written
// down. A trendChart's range and an activityGrid's range are closed words the
// host resolves against today every time it reads, so a file with dates fixed in
// 2026 would draw an empty year in 2027. The cost is that a rebuild moves the
// history; the station's now is the day it was built, and that is stated on the
// front page rather than left for somebody to work out.

const BUILT = new Date();

/** A civil date this many days before the build, as yyyy-MM-dd. */
export function day(offset) {
  const date = new Date(Date.UTC(BUILT.getUTCFullYear(), BUILT.getUTCMonth(), BUILT.getUTCDate() + offset));
  return date.toISOString().slice(0, 10);
}

const num = value => ({ $nendoNumber: String(value) });

// A small deterministic generator, so the same build day produces the same
// readings and a rebuild is a rebuild rather than a new dataset.
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export const modules = [
  ['module.hab-a', 'Hab A', 'NS-HAB-A', true, '106.0', -1780],
  ['module.hab-b', 'Hab B', 'NS-HAB-B', true, '106.0', -1240],
  ['module.lab', 'Laboratory', 'NS-LAB', true, '148.5', -1533],
  ['module.node1', 'Node 1', 'NS-NOD-1', true, '62.0', -1780],
  ['module.airlock', 'Airlock', 'NS-ALK', true, '34.0', -1402],
  ['module.truss', 'Truss', 'NS-TRS', false, '0.0', -1673],
  ['module.cupola', 'Cupola', 'NS-CUP', true, '18.5', -905],
].map(([recordId, name, designation, pressurised, volume, commissioned]) => ({
  recordId,
  values: {
    moduleName: name, moduleDesignation: designation, modulePressurised: pressurised,
    moduleVolume: num(volume), moduleCommissioned: day(commissioned),
  },
}));

export const systems = [
  ['system.o2', 'O2 Generation', 'LS-O2', 'Vital', 'Nominal', 'module.hab-a', '5.4', '3.9', 'kg/day', -1780],
  ['system.co2', 'CO2 Scrubbing', 'LS-CO2', 'Vital', 'Degraded', 'module.hab-b', '6.0', '5.1', 'kg/day', -1240],
  ['system.water', 'Water Reclamation', 'LS-H2O', 'Vital', 'Nominal', 'module.node1', '22.0', '14.6', 'L/day', -1780],
  // The demo system, and the one that starts clean: no incident, no flag.
  ['system.thermal', 'Thermal Control', 'TCS-1', 'Vital', 'Nominal', 'module.truss', '14.0', '9.2', 'kW', -1673],
  ['system.power-primary', 'Primary Power', 'EPS-PV', 'Vital', 'Nominal', 'module.truss', '84.0', '51.5', 'kW', -1673],
  ['system.power-battery', 'Battery Storage', 'EPS-BAT', 'Major', 'Maintenance', 'module.truss', '120.0', '78.0', 'kWh', -1673],
  ['system.power-dist', 'Power Distribution', 'EPS-DIST', 'Vital', 'Nominal', 'module.node1', '84.0', '51.5', 'kW', -1780],
  ['system.comms', 'Comms', 'COM-S', 'Major', 'Nominal', 'module.node1', '512.0', '180.0', 'kbit/s', -1780],
  ['system.attitude', 'Attitude Control', 'ACS-CMG', 'Major', 'Nominal', 'module.cupola', '4.0', '2.1', 'N m s', -905],
].map(([recordId, name, code, criticality, condition, moduleId, capacity, load, unit, commissioned]) => ({
  recordId,
  values: {
    systemName: name, systemCode: code, systemCriticality: criticality, systemCondition: condition,
    systemModule: moduleId, systemCommissioned: day(commissioned),
    systemCapacity: num(capacity), systemLoad: num(load), systemCapacityUnit: unit,
    systemReviewFlag: false,
  },
}));

export const crew = [
  ['crew.varga', 'Ilona Varga', 'Commander', 'Kestrel', -204, -21],
  ['crew.okonkwo', 'Dami Okonkwo', 'Flight engineer', 'Anvil', -204, -21],
  ['crew.lindqvist', 'Noor Lindqvist', 'Scientist', 'Beacon', -204, -21],
  ['crew.serrano', 'Rafa Serrano', 'Flight engineer', 'Ridge', -204, -21],
  ['crew.haddad', 'Yara Haddad', 'Medical officer', 'Lantern', -204, -21],
  ['crew.tanaka', 'Kenji Tanaka', 'Scientist', 'Compass', -204, -21],
  ['crew.petrov', 'Mira Petrov', 'Commander', 'Harrier', -35, 145],
  ['crew.adeyemi', 'Sola Adeyemi', 'Flight engineer', 'Girder', -35, 145],
  ['crew.novak', 'Eva Novak', 'Scientist', 'Prism', -35, 145],
  ['crew.bhatt', 'Arun Bhatt', 'Flight engineer', 'Tether', -35, 145],
  ['crew.rios', 'Camila Rios', 'Medical officer', 'Ember', -35, 145],
  ['crew.li', 'Wen Li', 'Scientist', 'Meridian', -35, 145],
].map(([recordId, name, role, callsign, start, end]) => ({
  recordId,
  values: {
    crewName: name, crewRole: role, crewCallsign: callsign,
    crewRotationStart: day(start), crewRotationEnd: day(end),
  },
}));

// label, kind, state, system, installed, interval, last serviced, next due
const componentRows = [
  // Thermal Control, which is where the schematic is worth drawing.
  ['component.therm-tank', 'Coolant reservoir', 'THERM', 'Tank', 'Online', 'system.thermal', -1673, 730, -300, 430],
  ['component.therm-pump-a', 'Coolant pump A', 'THERM', 'Pump', 'Online', 'system.thermal', -1673, 365, -120, 245],
  ['component.therm-pump-b', 'Coolant pump B', 'THERM', 'Pump', 'Standby', 'system.thermal', -1673, 365, -118, 247],
  ['component.therm-manifold', 'Coolant manifold', 'THERM', 'Valve', 'Online', 'system.thermal', -1673, 730, -410, 320],
  ['component.therm-loop-valve', 'Loop isolation valve', 'THERM', 'Valve', 'Online', 'system.thermal', -1673, 730, -410, 320],
  ['component.therm-radiator-1', 'Radiator 1', 'THERM', 'Radiator', 'Online', 'system.thermal', -1673, 1095, -640, 455],
  ['component.therm-radiator-2', 'Radiator 2', 'THERM', 'Radiator', 'Online', 'system.thermal', -1673, 1095, -640, 455],
  ['component.therm-hx-lab', 'Lab heat exchanger', 'THERM', 'Radiator', 'Online', 'system.thermal', -1533, 1095, -500, 595],
  ['component.therm-chiller', 'Cold plate chiller', 'THERM', 'Pump', 'Online', 'system.thermal', -1533, 365, -200, 165],
  ['component.therm-cold-plate', 'Lab cold plate', 'THERM', 'Radiator', 'Online', 'system.thermal', -1533, 730, -300, 430],
  ['component.therm-sensor-out', 'Outlet temperature sensor', 'THERM', 'Sensor', 'Online', 'system.thermal', -1673, 365, -90, 275],
  ['component.therm-controller', 'Thermal controller', 'THERM', 'Controller', 'Online', 'system.thermal', -1673, 1095, -700, 395],
  // O2 Generation
  ['component.o2-stack', 'Electrolysis stack', 'O2', 'Cell', 'Online', 'system.o2', -1780, 365, -150, 215],
  ['component.o2-feed-pump', 'Feedwater pump', 'O2', 'Pump', 'Online', 'system.o2', -1780, 365, -150, 215],
  ['component.o2-sensor', 'Oxygen sensor', 'O2', 'Sensor', 'Online', 'system.o2', -1780, 180, -40, 140],
  ['component.o2-controller', 'Generation controller', 'O2', 'Controller', 'Online', 'system.o2', -1780, 1095, -820, 275],
  // CO2 Scrubbing
  ['component.co2-bed-a', 'Sorbent bed A', 'CO2', 'Filter', 'Online', 'system.co2', -1240, 180, -170, 10],
  ['component.co2-bed-b', 'Sorbent bed B', 'CO2', 'Filter', 'Offline', 'system.co2', -1240, 180, -175, 5],
  ['component.co2-blower', 'Cabin blower', 'CO2', 'Pump', 'Online', 'system.co2', -1240, 365, -95, 270],
  ['component.co2-sensor', 'Carbon dioxide sensor', 'CO2', 'Sensor', 'Online', 'system.co2', -1240, 180, -30, 150],
  // Water Reclamation
  ['component.h2o-still', 'Distillation still', 'H2O', 'Filter', 'Online', 'system.water', -1780, 365, -210, 155],
  ['component.h2o-tank', 'Potable tank', 'H2O', 'Tank', 'Online', 'system.water', -1780, 730, -430, 300],
  ['component.h2o-pump', 'Recirculation pump', 'H2O', 'Pump', 'Online', 'system.water', -1780, 365, -210, 155],
  ['component.h2o-sensor', 'Conductivity sensor', 'H2O', 'Sensor', 'Online', 'system.water', -1780, 180, -60, 120],
  // Primary Power
  ['component.pwr-array-p', 'Array port', 'PWR', 'Cell', 'Online', 'system.power-primary', -1673, 1095, -700, 395],
  ['component.pwr-array-s', 'Array starboard', 'PWR', 'Cell', 'Online', 'system.power-primary', -1673, 1095, -700, 395],
  ['component.pwr-mppt', 'Charge regulator', 'PWR', 'Controller', 'Online', 'system.power-primary', -1673, 730, -350, 380],
  ['component.pwr-sensor', 'Bus current sensor', 'PWR', 'Sensor', 'Online', 'system.power-primary', -1673, 365, -80, 285],
  // Battery Storage
  ['component.bat-string-1', 'Battery string 1', 'BAT', 'Cell', 'Online', 'system.power-battery', -1673, 365, -110, 255],
  ['component.bat-string-2', 'Battery string 2', 'BAT', 'Cell', 'Standby', 'system.power-battery', -1673, 365, -110, 255],
  ['component.bat-controller', 'Charge controller', 'BAT', 'Controller', 'Online', 'system.power-battery', -1673, 730, -360, 370],
  // Power Distribution
  ['component.dist-main-bus', 'Main bus', 'DIST', 'Controller', 'Online', 'system.power-dist', -1780, 1095, -690, 405],
  ['component.dist-breaker-hab', 'Hab breaker', 'DIST', 'Controller', 'Online', 'system.power-dist', -1780, 730, -380, 350],
  ['component.dist-breaker-lab', 'Lab breaker', 'DIST', 'Controller', 'Online', 'system.power-dist', -1533, 730, -380, 350],
  ['component.dist-sensor', 'Bus voltage sensor', 'DIST', 'Sensor', 'Online', 'system.power-dist', -1780, 365, -75, 290],
  // Comms
  ['component.com-antenna', 'S-band antenna', 'COM', 'Controller', 'Online', 'system.comms', -1780, 1095, -600, 495],
  ['component.com-transceiver', 'Transceiver', 'COM', 'Controller', 'Online', 'system.comms', -1780, 730, -300, 430],
  ['component.com-sensor', 'Link quality sensor', 'COM', 'Sensor', 'Online', 'system.comms', -1780, 365, -100, 265],
  // Attitude Control
  ['component.acs-cmg-1', 'Control moment gyro 1', 'ACS', 'Controller', 'Online', 'system.attitude', -905, 365, -140, 225],
  ['component.acs-cmg-2', 'Control moment gyro 2', 'ACS', 'Controller', 'Online', 'system.attitude', -905, 365, -140, 225],
  ['component.acs-sensor', 'Rate sensor', 'ACS', 'Sensor', 'Online', 'system.attitude', -905, 180, -50, 130],
];

export const components = componentRows.map(
  ([recordId, name, prefix, kind, state, systemId, installed, interval, serviced, due], index) => ({
    recordId,
    values: {
      componentName: name,
      // The convention the custom view reads. The host discloses a label and one
      // status; the system a component belongs to rides in the label or not at all.
      componentSchematicLabel: `${prefix} · ${name}`,
      componentSystem: systemId, componentKind: kind, componentState: state,
      componentInstalled: day(installed),
      componentServiceInterval: num(interval),
      componentLastServiced: day(serviced),
      componentNextServiceDue: day(due),
      componentSerial: `${prefix}-${String(1000 + index * 7).padStart(4, '0')}`,
    },
  }));

// from, to, what it carries, whether it is a declared backup
const feedRows = [
  // Coolant. Two pumps onto one manifold is the redundant pair; the isolation
  // valve, radiator 2 and the lab exchanger are a real loop, because a coolant
  // circuit is a cycle and a work-dependency graph never is.
  ['component.therm-tank', 'component.therm-pump-a', 'Coolant', false],
  ['component.therm-tank', 'component.therm-pump-b', 'Coolant', true],
  ['component.therm-pump-a', 'component.therm-manifold', 'Coolant', false],
  ['component.therm-pump-b', 'component.therm-manifold', 'Coolant', true],
  ['component.therm-manifold', 'component.therm-radiator-1', 'Coolant', false],
  ['component.therm-manifold', 'component.therm-loop-valve', 'Coolant', false],
  ['component.therm-loop-valve', 'component.therm-radiator-2', 'Coolant', false],
  ['component.therm-radiator-2', 'component.therm-hx-lab', 'Coolant', false],
  ['component.therm-hx-lab', 'component.therm-loop-valve', 'Coolant', false],
  ['component.therm-manifold', 'component.therm-sensor-out', 'Coolant', false],
  // The cold plate hangs off pump A alone. Taking that pump out is the one case
  // where something loses every declared path while the manifold keeps one.
  ['component.therm-pump-a', 'component.therm-chiller', 'Coolant', false],
  ['component.therm-chiller', 'component.therm-cold-plate', 'Coolant', false],
  ['component.therm-sensor-out', 'component.therm-controller', 'Data', false],
  ['component.therm-controller', 'component.therm-manifold', 'Data', false],
  // Generation and storage onto the main bus.
  ['component.pwr-array-p', 'component.pwr-mppt', 'Power', false],
  ['component.pwr-array-s', 'component.pwr-mppt', 'Power', true],
  ['component.pwr-mppt', 'component.dist-main-bus', 'Power', false],
  ['component.pwr-sensor', 'component.pwr-mppt', 'Data', false],
  ['component.bat-string-1', 'component.bat-controller', 'Power', false],
  ['component.bat-string-2', 'component.bat-controller', 'Power', true],
  ['component.bat-controller', 'component.dist-main-bus', 'Power', true],
  ['component.dist-sensor', 'component.dist-main-bus', 'Data', false],
  // Distribution outward.
  ['component.dist-main-bus', 'component.dist-breaker-hab', 'Power', false],
  ['component.dist-main-bus', 'component.dist-breaker-lab', 'Power', false],
  ['component.dist-breaker-hab', 'component.o2-stack', 'Power', false],
  ['component.dist-breaker-hab', 'component.o2-feed-pump', 'Power', false],
  ['component.dist-breaker-hab', 'component.co2-blower', 'Power', false],
  ['component.dist-breaker-hab', 'component.h2o-pump', 'Power', false],
  ['component.dist-breaker-lab', 'component.therm-pump-a', 'Power', false],
  ['component.dist-breaker-lab', 'component.therm-pump-b', 'Power', false],
  ['component.dist-breaker-lab', 'component.therm-chiller', 'Power', false],
  ['component.dist-breaker-lab', 'component.com-transceiver', 'Power', false],
  ['component.dist-breaker-lab', 'component.acs-cmg-1', 'Power', false],
  ['component.dist-breaker-lab', 'component.acs-cmg-2', 'Power', true],
  // Air and water, including the second genuine loop: the still returns to the
  // tank it draws from.
  ['component.o2-feed-pump', 'component.o2-stack', 'Water', false],
  ['component.o2-sensor', 'component.o2-controller', 'Data', false],
  ['component.o2-controller', 'component.o2-stack', 'Data', false],
  ['component.co2-blower', 'component.co2-bed-a', 'Air', false],
  ['component.co2-blower', 'component.co2-bed-b', 'Air', true],
  ['component.co2-sensor', 'component.co2-blower', 'Data', false],
  ['component.h2o-tank', 'component.h2o-pump', 'Water', false],
  ['component.h2o-pump', 'component.h2o-still', 'Water', false],
  ['component.h2o-still', 'component.h2o-tank', 'Water', false],
  ['component.h2o-sensor', 'component.h2o-pump', 'Data', false],
  // Comms and attitude.
  ['component.com-transceiver', 'component.com-antenna', 'Data', false],
  ['component.com-sensor', 'component.com-transceiver', 'Data', false],
  ['component.acs-sensor', 'component.acs-cmg-1', 'Data', false],
  ['component.acs-sensor', 'component.acs-cmg-2', 'Data', true],
];

export const feeds = feedRows.map(([from, to, kind, redundant], index) => ({
  recordId: `feed.${String(index + 1).padStart(3, '0')}`,
  values: { feedFrom: from, feedTo: to, feedKind: kind, feedRedundant: redundant, feedNote: null },
}));

// Nothing against Thermal Control: it starts the demonstration clean, so the
// flag the trigger raises is visibly new.
const incidentRows = [
  ['incident.001', 'Sorbent bed B will not regenerate', 'system.co2', 'component.co2-bed-b', -6, null, 'Critical', 'Open'],
  ['incident.002', 'Cabin CO2 above the comfort band after exercise', 'system.co2', 'component.co2-sensor', -12, null, 'Elevated', 'Contained'],
  ['incident.003', 'Battery string 2 charges slower than string 1', 'system.power-battery', 'component.bat-string-2', -19, null, 'Elevated', 'Open'],
  ['incident.004', 'Downlink drops during the northern pass', 'system.comms', 'component.com-antenna', -27, null, 'Routine', 'Open'],
  ['incident.005', 'Conductivity spike after the filter change', 'system.water', 'component.h2o-sensor', -44, -41, 'Elevated', 'Resolved'],
  ['incident.006', 'Oxygen sensor reads low against the reference', 'system.o2', 'component.o2-sensor', -63, -58, 'Routine', 'Resolved'],
  ['incident.007', 'Gyro 1 saturates earlier than expected', 'system.attitude', 'component.acs-cmg-1', -78, -52, 'Elevated', 'Resolved'],
  ['incident.008', 'Hab breaker trips on galley start-up', 'system.power-dist', 'component.dist-breaker-hab', -96, -94, 'Critical', 'Resolved'],
  ['incident.009', 'Array port output below the seasonal model', 'system.power-primary', 'component.pwr-array-p', -121, -79, 'Elevated', 'Resolved'],
  ['incident.010', 'Recirculation pump noisy at low flow', 'system.water', 'component.h2o-pump', -152, -150, 'Routine', 'Stood down'],
  ['incident.011', 'Electrolysis stack efficiency drifting', 'system.o2', 'component.o2-stack', -188, -131, 'Elevated', 'Resolved'],
  ['incident.012', 'Link quality sensor reports without a fault', 'system.comms', 'component.com-sensor', -214, -213, 'Routine', 'Stood down'],
  ['incident.013', 'Charge regulator restarted itself twice', 'system.power-primary', 'component.pwr-mppt', -256, -249, 'Critical', 'Resolved'],
  ['incident.014', 'Potable tank level reads high after transfer', 'system.water', 'component.h2o-tank', -298, -297, 'Routine', 'Stood down'],
];

export const incidents = incidentRows.map(
  ([recordId, title, systemId, componentId, raised, resolved, severity, status]) => ({
    recordId,
    values: {
      incidentTitle: title, incidentSystem: systemId, incidentComponent: componentId,
      incidentRaised: day(raised), incidentResolved: resolved === null ? null : day(resolved),
      incidentSeverity: severity, incidentStatus: status,
      incidentSummary: null,
    },
  }));

const maintenanceRows = [
  ['maint.001', 'Replace sorbent bed B', 'component.co2-bed-b', 'Replace', -6, 4, null, 'In progress', '6.0'],
  ['maint.002', 'Calibrate the carbon dioxide sensor', 'component.co2-sensor', 'Calibrate', -12, 2, null, 'Scheduled', '1.5'],
  ['maint.003', 'Inspect battery string 2 connections', 'component.bat-string-2', 'Inspection', -19, 9, null, 'Scheduled', '2.0'],
  ['maint.004', 'Clean the S-band antenna feed', 'component.com-antenna', 'Clean', -27, 16, null, 'Scheduled', '2.5'],
  ['maint.005', 'Calibrate the outlet temperature sensor', 'component.therm-sensor-out', 'Calibrate', -30, 23, null, 'Scheduled', '1.0'],
  ['maint.006', 'Inspect coolant pump A bearings', 'component.therm-pump-a', 'Inspection', -34, 28, null, 'Scheduled', '3.0'],
  ['maint.007', 'Replace the conductivity sensor', 'component.h2o-sensor', 'Replace', -44, -38, -39, 'Done', '2.0'],
  ['maint.008', 'Calibrate the oxygen sensor', 'component.o2-sensor', 'Calibrate', -63, -57, -58, 'Done', '1.0'],
  ['maint.009', 'Rebalance control moment gyro 1', 'component.acs-cmg-1', 'Calibrate', -78, -60, -52, 'Done', '4.5'],
  ['maint.010', 'Inspect the hab breaker contacts', 'component.dist-breaker-hab', 'Inspection', -96, -90, -94, 'Done', '1.5'],
  ['maint.011', 'Clean array port cells', 'component.pwr-array-p', 'Clean', -121, -100, -79, 'Done', '5.0'],
  ['maint.012', 'Inspect the recirculation pump', 'component.h2o-pump', 'Inspection', -152, -145, -150, 'Done', '2.0'],
  ['maint.013', 'Replace the electrolysis stack membrane', 'component.o2-stack', 'Replace', -188, -140, -131, 'Done', '9.0'],
  ['maint.014', 'Inspect the link quality sensor', 'component.com-sensor', 'Inspection', -214, -210, -213, 'Done', '1.0'],
  ['maint.015', 'Replace the charge regulator', 'component.pwr-mppt', 'Replace', -256, -250, -249, 'Done', '7.5'],
  ['maint.016', 'Clean radiator 1 surfaces', 'component.therm-radiator-1', 'Clean', -300, -280, -285, 'Done', '6.0'],
  ['maint.017', 'Inspect the coolant reservoir seals', 'component.therm-tank', 'Inspection', -300, -290, -300, 'Done', '2.5'],
  ['maint.018', 'Calibrate the bus voltage sensor', 'component.dist-sensor', 'Calibrate', -75, -60, -75, 'Done', '1.0'],
  ['maint.019', 'Inspect the cold plate chiller', 'component.therm-chiller', 'Inspection', -200, -180, null, 'Deferred', '2.0'],
  ['maint.020', 'Replace the lab heat exchanger gaskets', 'component.therm-hx-lab', 'Replace', -120, -60, null, 'Deferred', '8.0'],
];

export const maintenance = maintenanceRows.map(
  ([recordId, title, componentId, kind, opened, due, completed, status, hours]) => ({
    recordId,
    values: {
      taskTitle: title, taskComponent: componentId, taskKind: kind,
      taskOpened: day(opened), taskDue: day(due),
      taskCompleted: completed === null ? null : day(completed),
      taskStatus: status, taskHours: num(hours),
    },
  }));

const experimentRows = [
  ['exp.001', 'Protein crystal growth, run 7', 'crew.novak', 'module.lab', 'system.power-dist', -40, 35, 'Running', '310.0', 4],
  ['exp.002', 'Cold plate thermal cycling', 'crew.bhatt', 'module.lab', 'system.thermal', -18, 60, 'Running', '1240.0', 5],
  ['exp.003', 'Sorbent regeneration at reduced pressure', 'crew.li', 'module.hab-b', 'system.co2', 12, 110, 'Proposed', '180.0', 3],
  ['exp.004', 'Long-baseline optical tracking', 'crew.petrov', 'module.cupola', 'system.attitude', 20, 140, 'Proposed', '95.0', 2],
  ['exp.005', 'Water recovery from humidity condensate', 'crew.lindqvist', 'module.node1', 'system.water', -150, -45, 'Complete', '420.0', 4],
  ['exp.006', 'Radiation dosimetry across the truss', 'crew.tanaka', 'module.truss', 'system.power-dist', -190, -60, 'Complete', '60.0', 3],
  ['exp.007', 'Plant growth under variable light', 'crew.haddad', 'module.lab', 'system.power-dist', -240, -120, 'Complete', '260.0', 5],
  ['exp.008', 'Acoustic survey of the hab modules', 'crew.serrano', 'module.hab-a', 'system.power-dist', -170, -160, 'Halted', '45.0', 1],
];

export const experiments = experimentRows.map(
  ([recordId, title, lead, moduleId, systemId, start, end, status, power, priority]) => ({
    recordId,
    values: {
      experimentTitle: title, experimentLead: lead, experimentModule: moduleId,
      experimentSystem: systemId, experimentStart: day(start), experimentEnd: day(end),
      experimentStatus: status, experimentPower: num(power), experimentPriority: num(priority),
    },
  }));

// Readings are imported from CSV rather than written over MCP: it is the one
// shipped capability the other reference applications never exercised end to
// end, and a few hundred rows is what it is for. Choice and reference values are
// stable IDs, exactly as the CSV contract requires.
const readingSeries = [
  ['system.thermal', 'Temperature', 'degC', 1, 120, 18.5, 2.4],
  ['system.o2', 'Oxygen', 'kPa', 2, 120, 21.2, 0.5],
  ['system.co2', 'Carbon dioxide', 'mmHg', 2, 120, 3.6, 0.9],
  ['system.water', 'Water', 'L', 3, 120, 14.6, 1.8],
  ['system.power-primary', 'Power draw', 'kW', 2, 120, 51.5, 6.0],
];

export function readingRows() {
  const random = sequence(20260922);
  const rows = [];
  for (const [systemId, metric, unit, step, span, centre, spread] of readingSeries) {
    for (let back = span; back >= 0; back -= step) {
      const drift = (random() - 0.5) * 2 * spread;
      const value = (centre + drift).toFixed(2);
      // A reading outside limits is an operator's judgement in this file, so it
      // is stored rather than worked out from the number beside it.
      const outside = Math.abs(drift) > spread * 0.88;
      rows.push({
        readingSystem: systemId,
        readingTaken: day(-back),
        readingMetric: metric,
        readingValue: value,
        readingUnit: unit,
        readingOutOfLimits: outside ? 'true' : 'false',
      });
    }
  }
  return rows;
}

export function readingsCsv() {
  const columns = ['readingSystem', 'readingTaken', 'readingMetric', 'readingValue', 'readingUnit', 'readingOutOfLimits'];
  const lines = [columns.join(',')];
  for (const row of readingRows()) lines.push(columns.map(column => row[column]).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
