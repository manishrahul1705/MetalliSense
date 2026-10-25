/**
 * Handheld gun service: starts the gun OPC UA simulator, connects an OPC UA
 * client to it, runs inspections, streams readings to a live buffer the UI
 * polls, and hands the finished CSV export to the ingest adapter.
 *
 * Same shape as opcuaService.js for the spectrometer.
 */
const { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } = require('node-opcua');
const HandheldGunOPCUAServer = require('./gunOpcuaServer');
const { ingestCsv, parseCsv, flagPiece } = require('./gunIngest');
const store = require('./store');
const scorecard = require('./supplierScorecard');

const N = (name) => `ns=1;s=Gun.${name}`;

class GunService {
  constructor() {
    this.server = new HandheldGunOPCUAServer();
    this.client = null;
    this.session = null;
    this.connected = false;
    this.lastError = null;
    this.live = null; // current / last session as the UI sees it
  }

  async initializeServerOnly(attempts = 6) {
    // The spectrometer simulator starts at the same moment and may still be
    // creating the shared OPC UA certificate, so retry a few times.
    for (let i = 1; i <= attempts; i++) {
      await new Promise((r) => setTimeout(r, i === 1 ? 1500 : 2500));
      this.server = i === 1 ? this.server : new HandheldGunOPCUAServer();
      if ((await this.server.initialize()) && (await this.server.start())) return true;
    }
    return false;
  }

  async connect() {
    if (this.connected) return { success: true, message: 'Gun client already connected' };
    try {
      const clientOpts = {
        applicationName: 'MetalliSense Gun Client',
        connectionStrategy: { initialDelay: 500, maxRetry: 2 },
        securityMode: MessageSecurityMode.None,
        securityPolicy: SecurityPolicy.None,
        endpointMustExist: false,
      };
      if (process.env.OPCUA_PKI_DIR) {
        const path = require('path');
        const { OPCUACertificateManager } = require('node-opcua-certificate-manager');
        clientOpts.clientCertificateManager = new OPCUACertificateManager({
          rootFolder: path.join(process.env.OPCUA_PKI_DIR, 'client')
        });
      }
      this.client = OPCUAClient.create(clientOpts);
      await this.client.connect(this.server.getStatus().endpoint);
      this.session = await this.client.createSession();
      this.connected = true;
      this.lastError = null;
      return { success: true, message: 'Connected to handheld gun simulator' };
    } catch (error) {
      this.connected = false;
      this.lastError = error.message;
      return { success: false, error: error.message };
    }
  }

  async disconnect() {
    try {
      await this.session?.close();
      await this.client?.disconnect();
    } catch { /* ignore */ }
    this.connected = false;
    this.session = null;
    return { success: true, message: 'Gun client disconnected' };
  }

  status() {
    return {
      server: this.server.getStatus(),
      client: { isConnected: this.connected, lastError: this.lastError },
      live: this.live ? this.liveView() : null,
    };
  }

  liveView() {
    const { csv, ...rest } = this.live;
    return rest;
  }

  async read(names) {
    const results = await this.session.read(names.map((n) => ({ nodeId: N(n), attributeId: AttributeIds.Value })));
    const out = {};
    names.forEach((n, i) => { out[n] = results[i].value?.value; });
    return out;
  }

  /** Start an inspection. Returns at once; readings stream into this.live. */
  async startInspection({ lotId, device = 'XRF', pieces, surfacePrepared = false, inspector = 'Yard inspector' }) {
    const lot = store.getLot(lotId);
    if (!lot) throw Object.assign(new Error(`Lot ${lotId} not found`), { status: 404 });
    if (!['STEEL_SCRAP', 'CI_SCRAP'].includes(lot.materialType)) {
      throw Object.assign(new Error('Yard gun inspection is for scrap lots. Sponge iron goes to the QA lab.'), { status: 400 });
    }
    // The supplier's grade sets the minimum number of pieces: A 10, B 15, C/new 25, D 30.
    const supplierGrade = scorecard.gradeForLot(lot);
    const minPieces = supplierGrade?.inspectPieces || 15;
    let piecesNote = null;
    if (!(Number(pieces) > 0)) {
      pieces = minPieces;
      piecesNote = `${pieces} pieces set by supplier grade ${supplierGrade?.grade || 'NEW'}`;
    } else if (Number(pieces) < minPieces) {
      piecesNote = `Raised from ${pieces} to ${minPieces} pieces: ${lot.supplier} is grade ${supplierGrade.grade}`;
      pieces = minPieces;
    }
    pieces = Number(pieces);
    if (this.server.busy) throw Object.assign(new Error('The gun is already testing a lot'), { status: 409 });
    if (!this.connected) {
      const c = await this.connect();
      if (!c.success) throw Object.assign(new Error(`Cannot reach gun simulator: ${c.error}`), { status: 503 });
    }

    const sessionId = store.sessions.nextId();
    const cmd = { sessionId, lotId, device, pieces, surfacePrepared, sessionNo: lot.sessionIds.length + 1 };
    const result = await this.session.write({
      nodeId: N('Command'),
      attributeId: AttributeIds.Value,
      value: { value: { dataType: 'String', value: JSON.stringify(cmd) } },
    });
    if (result && result.name && result.name !== 'Good') {
      throw Object.assign(new Error(`Gun rejected the command (${result.name})`), { status: 409 });
    }

    this.live = { sessionId, lotId, device, inspector, status: 'Starting', piecesPlanned: pieces, piecesDone: 0, readings: [], result: null, error: null, startedAt: new Date(), supplierGrade, piecesNote };
    this.poll(sessionId);
    return this.liveView();
  }

  async poll(sessionId) {
    const started = Date.now();
    const tick = async () => {
      if (!this.live || this.live.sessionId !== sessionId) return;
      try {
        const s = await this.read(['Status', 'SessionId', 'PiecesPlanned', 'PiecesDone', 'ReadingsCsv', 'ArgonRemaining']);
        if (s.SessionId !== sessionId && !String(s.Status).startsWith('Error')) {
          if (Date.now() - started < 5000) { setTimeout(tick, 250); return; }
        }
        this.live.status = s.Status;
        this.live.piecesPlanned = s.PiecesPlanned;
        this.live.piecesDone = s.PiecesDone;
        this.live.argonRemaining = s.ArgonRemaining;
        if (s.ReadingsCsv && s.ReadingsCsv.includes('\n')) {
          this.live.readings = parseCsv(s.ReadingsCsv).map((r) => ({ ...r, flags: flagPiece(r) }));
        }
        if (String(s.Status).startsWith('Error')) {
          this.live.error = s.Status.replace(/^Error:\s*/, '');
          return;
        }
        if (s.Status === 'Session Complete') {
          const session = ingestCsv(s.ReadingsCsv, { sessionId, inspector: this.live.inspector, via: 'OPC_UA_SIMULATOR' });
          this.live.result = { evidence: session.evidence, decision: session.decision, lot: store.view(store.getLot(session.lotId)) };
          this.live.status = 'Session Complete';
          return;
        }
        if (Date.now() - started > 120000) { this.live.error = 'Timed out waiting for the gun'; return; }
      } catch (error) {
        this.live.error = error.message;
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  replaceArgon() { return this.server.replaceArgonCanister(); }
}

module.exports = new GunService();
