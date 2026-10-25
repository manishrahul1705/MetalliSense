/**
 * Handheld XRF / LIBS gun — OPC UA simulator.
 *
 * Works like the spectrometer simulator (opcua-server/opcuaServer.js):
 * the backend's OPC UA client writes a command node, the server "tests"
 * pieces one by one and publishes each reading, and the client reads the
 * results back.
 *
 * Endpoint: opc.tcp://localhost:4335/MetalliSense/HandheldGun
 *
 * Nodes (ns=1):
 *   Gun.Command        (write) JSON {sessionId, lotId, device, pieces, surfacePrepared, sessionNo}
 *   Gun.Status         Idle | Testing piece k/N | Session Complete | Error: ...
 *   Gun.SessionId, Gun.LotId, Gun.DeviceType
 *   Gun.PiecesPlanned, Gun.PiecesDone
 *   Gun.LastReading    JSON of the latest CSV row
 *   Gun.ReadingsCsv    CSV export so far (same format a real gun exports)
 *   Gun.ArgonRemaining LIBS argon canister (carbon tests left)
 *
 * Every finished session is also written to premeltGate/gun_exports/<sessionId>.csv,
 * like a real gun's export folder.
 */
const fs = require('fs');
const path = require('path');
const { OPCUAServer, Variant, DataType, StatusCodes } = require('node-opcua');
const { OPCUACertificateManager } = require('node-opcua-certificate-manager');
const store = require('./store');
const { simulateSession, toCsv } = require('./gunSimulator');
const { settings } = require('./config');

const EXPORT_DIR = path.join(__dirname, 'gun_exports');
const PORT = Number(process.env.GUN_OPCUA_PORT) || 4335;
const STEP_MS = Number(process.env.GUN_STEP_MS) || 350;

class HandheldGunOPCUAServer {
  constructor() {
    this.server = null;
    this.state = this.idleState();
    this.argonRemaining = settings.gun.argonTestsPerCanister;
    this.busy = false;
  }

  idleState() {
    return { status: 'Idle', sessionId: '', lotId: '', device: '', planned: 0, done: 0, lastReading: '', rows: [] };
  }

  async initialize() {
    try {
      const serverOpts = {
        port: PORT,
        resourcePath: '/MetalliSense/HandheldGun',
        buildInfo: { productName: 'MetalliSense Handheld XRF/LIBS Simulator', buildNumber: '1.0.0', buildDate: new Date() },
      };
      if (process.env.OPCUA_PKI_DIR) {
        serverOpts.serverCertificateManager = new OPCUACertificateManager({
          rootFolder: path.join(process.env.OPCUA_PKI_DIR, 'server')
        });
      }
      this.server = new OPCUAServer(serverOpts);
      await this.server.initialize();
      this.createVariables();
      return true;
    } catch (error) {
      console.error('Failed to initialize Gun OPC UA Server:', error.message);
      return false;
    }
  }

  createVariables() {
    const addressSpace = this.server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();
    const folder = ns.addFolder(addressSpace.rootFolder.objects, { browseName: 'HandheldGun', nodeId: 'ns=1;s=GunFolder' });

    const str = (name, getter, setter) => ns.addVariable({
      componentOf: folder, browseName: name, nodeId: `ns=1;s=Gun.${name}`, dataType: DataType.String, minimumSamplingInterval: 100,
      value: {
        get: () => new Variant({ dataType: DataType.String, value: getter() }),
        ...(setter ? { set: setter } : {}),
      },
    });
    const int = (name, getter) => ns.addVariable({
      componentOf: folder, browseName: name, nodeId: `ns=1;s=Gun.${name}`, dataType: DataType.Int32, minimumSamplingInterval: 100,
      value: { get: () => new Variant({ dataType: DataType.Int32, value: getter() }) },
    });

    str('Command', () => '', (variant) => this.onCommand(variant.value));
    str('Status', () => this.state.status);
    str('SessionId', () => this.state.sessionId);
    str('LotId', () => this.state.lotId);
    str('DeviceType', () => this.state.device);
    int('PiecesPlanned', () => this.state.planned);
    int('PiecesDone', () => this.state.done);
    str('LastReading', () => this.state.lastReading);
    str('ReadingsCsv', () => toCsv(this.state.rows));
    int('ArgonRemaining', () => this.argonRemaining);
  }

  onCommand(json) {
    if (this.busy) return StatusCodes.BadResourceUnavailable;
    let cmd;
    try { cmd = JSON.parse(json); } catch { return StatusCodes.BadInvalidArgument; }
    const lot = store.getLot(cmd.lotId);
    if (!lot) { this.state = { ...this.idleState(), status: `Error: lot ${cmd.lotId} not found` }; return StatusCodes.Good; }

    const device = cmd.device === 'LIBS' ? 'LIBS' : 'XRF';
    const pieces = Number(cmd.pieces) || settings.gun.defaultPieces;
    if (device === 'LIBS' && this.argonRemaining < pieces) {
      this.state = { ...this.idleState(), status: `Error: argon canister low (${this.argonRemaining} carbon tests left) — replace canister` };
      return StatusCodes.Good;
    }

    const sim = simulateSession(lot, { device, pieces, surfacePrepared: !!cmd.surfacePrepared, sessionNo: cmd.sessionNo, deviceId: `${device}-01` });
    this.busy = true;
    this.state = { status: `Testing piece 0/${sim.rows.length}`, sessionId: cmd.sessionId, lotId: lot.lotId, device, planned: sim.rows.length, done: 0, lastReading: '', rows: [] };

    // Publish one piece at a time, like an inspector walking the load.
    const step = () => {
      const row = sim.rows[this.state.done];
      this.state.rows.push(row);
      this.state.done += 1;
      this.state.lastReading = JSON.stringify(row);
      if (device === 'LIBS') this.argonRemaining -= 1;
      if (this.state.done < sim.rows.length) {
        this.state.status = `Testing piece ${this.state.done}/${sim.rows.length}`;
        setTimeout(step, STEP_MS);
      } else {
        this.writeExport(this.state.sessionId, toCsv(this.state.rows));
        this.state.status = 'Session Complete';
        this.busy = false;
      }
    };
    setTimeout(step, STEP_MS);
    return StatusCodes.Good;
  }

  writeExport(sessionId, csv) {
    try {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(EXPORT_DIR, `${sessionId}.csv`), csv);
    } catch (e) {
      console.warn('Could not write gun export:', e.message);
    }
  }

  replaceArgonCanister() {
    this.argonRemaining = settings.gun.argonTestsPerCanister;
    return this.argonRemaining;
  }

  async start() {
    try {
      await this.server.start();
      console.log('Handheld gun OPC UA simulator:', this.server.endpoints[0].endpointDescriptions()[0].endpointUrl);
      return true;
    } catch (error) {
      console.error('Failed to start Gun OPC UA Server:', error.message);
      return false;
    }
  }

  async stop() {
    try { await this.server?.shutdown(); } catch { /* ignore */ }
  }

  getStatus() {
    return {
      isRunning: !!this.server,
      endpoint: `opc.tcp://localhost:${PORT}/MetalliSense/HandheldGun`,
      status: this.state.status,
      busy: this.busy,
      argonRemaining: this.argonRemaining,
    };
  }
}

module.exports = HandheldGunOPCUAServer;
