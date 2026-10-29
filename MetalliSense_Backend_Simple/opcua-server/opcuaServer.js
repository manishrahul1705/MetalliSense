const { OPCUAServer, Variant, DataType, StatusCodes } = require('node-opcua');
const gradeStore = require('../gradeSpecStore');

// Generates a plausible synthetic reading for a grade using the CSV-derived
// composition ranges (min/max per element), same logic as the original
// Mongo-backed version — just reading from gradeSpecStore instead.
function generateSyntheticReading(metalGrade, deviationElements = [], deviationPercentage = 10) {
  const spec = gradeStore.getByName(metalGrade);
  if (!spec) {
    throw new Error(`Metal grade '${metalGrade}' not found in specifications`);
  }

  const composition = {};
  const actualDeviationElements = [];

  Object.entries(spec.composition_ranges).forEach(([element, range]) => {
    const [min, max] = range;
    const midpoint = (min + max) / 2;
    const tolerance = (max - min) / 2;

    let value;
    if (deviationElements.includes(element)) {
      const deviationAmount = (tolerance * deviationPercentage) / 100;
      value = Math.max(0, min - deviationAmount);
      actualDeviationElements.push(element);
    } else {
      const variation = (Math.random() - 0.5) * tolerance * 0.8;
      value = midpoint + variation;
    }
    composition[element] = Math.round(value * 1000) / 1000;
  });

  return {
    metalGrade: metalGrade.toUpperCase(),
    metal_grade: metalGrade.toUpperCase(), // kept for any caller expecting snake_case
    composition,
    is_synthetic: true,
    deviation_applied: actualDeviationElements.length > 0,
    deviation_elements: actualDeviationElements,
  };
}

class SpectrometerOPCUAServer {
  constructor() {
    this.server = null;
    this.namespace = null;
    this.variables = {};
    this.currentGrade = null;
    this.currentComposition = {};
    this.currentStatus = 'Ready';
    this.lastReading = null;
  }

  async initialize() {
    try {
      this.server = new OPCUAServer({
        port: 4334,
        resourcePath: '/MetalliSense/Spectrometer',
        buildInfo: {
          productName: 'MetalliSense Spectrometer Simulator',
          buildNumber: '1.0.0',
          buildDate: new Date(),
        },
      });

      this.server.on('post_initialize', () => {
        try {
          const addressSpace = this.server.engine.addressSpace;
          this.namespace = addressSpace.getOwnNamespace();
          this.createVariables();
          this.initializeDefaultData();
          console.log('OPC UA Variables created successfully');
        } catch (error) {
          console.error('Failed to create OPC UA variables:', error);
        }
      });

      await this.server.initialize();
      console.log('OPC UA Server initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize OPC UA Server:', error);
      return false;
    }
  }

  initializeDefaultData() {
    this.currentComposition = {
      Fe: 85.5, C: 3.2, Si: 2.1, Mn: 0.8, P: 0.04, S: 0.02,
      Cr: 0.3, Ni: 0.15, Mo: 0.05, Cu: 0.25,
    };
    this.lastReading = {
      composition: new Map(Object.entries(this.currentComposition)),
      temperature: this.generateTemperature(),
      pressure: this.generatePressure(),
      deviation_elements: [],
    };
    this.currentStatus = 'Ready';
    console.log('Initialized with default composition data');
  }

  createVariables() {
    const addressSpace = this.server.engine.addressSpace;
    const rootFolder = addressSpace.rootFolder;

    const spectrometerFolder = this.namespace.addFolder(rootFolder.objects, {
      browseName: 'Spectrometer',
      displayName: 'Spectrometer Data',
      nodeId: 'ns=1;s=SpectrometerFolder',
    });

    this.variables.requestedGrade = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'RequestedGrade',
      nodeId: 'ns=1;s=RequestedGrade',
      dataType: DataType.String,
      value: {
        get: () => new Variant({ dataType: DataType.String, value: this.currentGrade || '' }),
        set: (variant) => {
          this.currentGrade = variant.value;
          this.generateNewReading();
          return StatusCodes.Good;
        },
      },
    });

    this.variables.status = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'Status',
      nodeId: 'ns=1;s=Status',
      dataType: DataType.String,
      value: { get: () => new Variant({ dataType: DataType.String, value: this.currentStatus }) },
    });

    this.variables.composition = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'Composition',
      nodeId: 'ns=1;s=Composition',
      dataType: DataType.String,
      value: { get: () => new Variant({ dataType: DataType.String, value: JSON.stringify(this.currentComposition) }) },
    });

    ['Fe', 'C', 'Si', 'Mn', 'P', 'S', 'Cr', 'Ni', 'Mo', 'Cu'].forEach((element) => {
      this.variables[element] = this.namespace.addVariable({
        componentOf: spectrometerFolder,
        browseName: element,
        displayName: `${element} (%)`,
        nodeId: `ns=1;s=${element}`,
        dataType: DataType.Double,
        value: { get: () => new Variant({ dataType: DataType.Double, value: this.currentComposition[element] || 0.0 }) },
      });
    });

    this.variables.temperature = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'Temperature',
      nodeId: 'ns=1;s=Temperature',
      dataType: DataType.Double,
      value: { get: () => new Variant({ dataType: DataType.Double, value: this.lastReading?.temperature || 0 }) },
    });

    this.variables.pressure = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'Pressure',
      nodeId: 'ns=1;s=Pressure',
      dataType: DataType.Double,
      value: { get: () => new Variant({ dataType: DataType.Double, value: this.lastReading?.pressure || 0 }) },
    });

    this.variables.deviationElements = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'DeviationElements',
      nodeId: 'ns=1;s=DeviationElements',
      dataType: DataType.String,
      value: { get: () => new Variant({ dataType: DataType.String, value: JSON.stringify(this.lastReading?.deviation_elements || []) }) },
    });

    this.variables.deviationPercentage = this.namespace.addVariable({
      componentOf: spectrometerFolder,
      browseName: 'DeviationPercentage',
      nodeId: 'ns=1;s=DeviationPercentage',
      dataType: DataType.Double,
      value: {
        get: () => new Variant({ dataType: DataType.Double, value: this.deviationPercentage || 10 }),
        set: (variant) => { this.deviationPercentage = variant.value; return StatusCodes.Good; },
      },
    });

    console.log(`Created ${Object.keys(this.variables).length} OPC UA variables:`, Object.keys(this.variables));
    console.log('Variables organized under Spectrometer folder');
  }

  generateNewReading() {
    try {
      this.currentStatus = 'Generating Reading...';
      if (!this.currentGrade) {
        this.currentStatus = 'No Grade Specified';
        return;
      }

      const synthetic = generateSyntheticReading(
        this.currentGrade,
        this.deviationElements || [],
        this.deviationPercentage || 10,
      );

      this.currentComposition = this.simulationSample ? { ...this.simulationSample.composition } : synthetic.composition;
      this.lastReading = {
        ...synthetic,
        temperature: this.generateTemperature(),
        pressure: this.generatePressure(),
      };
      this.currentStatus = 'Reading Complete';
      console.log(`Generated new reading for grade: ${this.currentGrade}`);
    } catch (error) {
      console.error('Error generating reading:', error);
      this.currentStatus = `Error: ${error.message}`;
    }
  }

  generateTemperature() {
    return Math.round(1400 + Math.random() * 200);
  }

  generatePressure() {
    return Math.round((0.95 + Math.random() * 0.1) * 100) / 100;
  }

  setDeviationElements(elements = []) {
    this.deviationElements = elements;
    if (this.currentGrade) this.generateNewReading();
  }

  async start() {
    try {
      await this.server.start();
      console.log('OPC UA Server started successfully');
      console.log('Server endpoint:', this.server.endpoints[0].endpointDescriptions()[0].endpointUrl);
      return true;
    } catch (error) {
      console.error('Failed to start OPC UA Server:', error);
      return false;
    }
  }

  async stop() {
    try {
      await this.server.shutdown();
      console.log('OPC UA Server stopped');
    } catch (error) {
      console.error('Error stopping OPC UA Server:', error);
    }
  }

  getStatus() {
    return {
      isRunning: !!this.server,
      currentGrade: this.currentGrade,
      currentStatus: this.currentStatus,
      lastReading: this.lastReading,
      endpoint: this.server?.endpoints[0]?.endpointDescriptions()[0]?.endpointUrl || null,
    };
  }
}

module.exports = SpectrometerOPCUAServer;
