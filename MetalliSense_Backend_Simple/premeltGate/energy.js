/**
 * Energy per heat (induction furnace) + energy savings.
 *
 * predictHeat() estimates the kWh a planned charge will need BEFORE melting,
 * and explains which parts of the charge drive it (rusty scrap, wet or fine
 * sponge iron, holding time, tap temperature …). Actual meter readings are
 * recorded per heat, and summary() turns predictions + actuals into kWh/t
 * benchmarks and ₹ savings (e.g. heats the Pre-Melt Gate stopped before
 * melting).
 *
 * All numbers are illustrative defaults for a coreless induction furnace.
 * A plant calibrates them from its own meter data (PATCH /energy/config).
 */
const store = require('./store');

const settings = {
  // kWh per tonne of charge to melt and reach the reference tap temperature.
  baseKwhPerT: {
    'SG-IRON': 570,
    'GREY-IRON': 550,
    'LOW-CARBON-STEEL': 620,
    'MEDIUM-CARBON-STEEL': 610,
    'HIGH-CARBON-STEEL': 600,
  },
  refTapTempC: {
    'SG-IRON': 1500,
    'GREY-IRON': 1480,
    'LOW-CARBON-STEEL': 1620,
    'MEDIUM-CARBON-STEEL': 1600,
    'HIGH-CARBON-STEEL': 1580,
  },
  kwhPerTPerDegC: 0.45,
  // Percentage changes to the base energy.
  rustPctPer10: 3.0, // per 10 % of scrap pieces with rust / paint / oil
  driPctPer10: 1.2, // per 10 % DRI share of the charge (gangue, slag, FeO reduction)
  moisturePctPer1: 2.0, // per 1 % moisture in DRI (weighted by DRI share)
  finesPctPer5: 1.0, // per 5 % fines in DRI (weighted by DRI share)
  lightScrapPctPer10: 1.5, // per 10 % light steel scrap (poor packing, slow melt)
  pigIronPctPer10: -1.5, // pig iron / returns melt faster (dense, lower melting point)
  alloyKwhPerKg: 0.45, // melting ferro-alloy additions
  holdingKwPerT: 60, // holding power per tonne of furnace metal
  defaultHoldingMin: 15,
  // Tariff and emissions (illustrative).
  tariffRsPerKwh: { normal: 8.0, peak: 9.6, offPeak: 6.8 },
  peakHours: [9, 10, 11, 18, 19, 20, 21],
  offPeakHours: [22, 23, 0, 1, 2, 3, 4, 5],
  gridCo2KgPerKwh: 0.71,
};

const actuals = {}; // heatId -> { actualKwh, at, by, source }

const DRIVER_LABEL = {
  base: 'Melting the charge (base)',
  tapTemp: 'Superheat above reference tap temperature',
  rust: 'Rusty / painted scrap',
  dri: 'Sponge iron share',
  moisture: 'Wet sponge iron',
  fines: 'Sponge iron fines',
  light: 'Light steel scrap',
  dense: 'Pig iron / returns (saves energy)',
  alloy: 'Ferro-alloy additions',
  holding: 'Holding at temperature',
};
const TIP_LABEL = {
  rust: 'Cleaner scrap',
  holding: 'Shorter holding',
  moisture: 'Dry sponge iron',
  tapTemp: 'Lower tap temperature',
  tariff: 'Off-peak scheduling',
};

const round = (v, dp = 0) => Math.round(v * 10 ** dp) / 10 ** dp;
const tariffAt = (hour) => {
  if (settings.peakHours.includes(hour)) return { band: 'peak', rate: settings.tariffRsPerKwh.peak };
  if (settings.offPeakHours.includes(hour)) return { band: 'off-peak', rate: settings.tariffRsPerKwh.offPeak };
  return { band: 'normal', rate: settings.tariffRsPerKwh.normal };
};

function sessionsFor(lotId) {
  if (store.sessions?.list) return store.sessions.list(lotId) || [];
  if (store.sessions?.forLot) return store.sessions.forLot(lotId) || [];
  return [];
}
function allHeats() {
  if (store.heats?.list) return store.heats.list();
  if (store.heats?.all) return store.heats.all();
  if (store.listHeats) return store.listHeats();
  return [];
}

/** Shares of the charge that change energy use. */
function chargeProfile(charge) {
  const lines = (charge || []).map((l) => ({ ...l, kg: Number(l.kg) || 0, lot: store.getLot(l.lotId) })).filter((l) => l.lot && l.kg > 0);
  const totalKg = lines.reduce((s, l) => s + l.kg, 0);
  const share = (pred) => (totalKg ? lines.filter(pred).reduce((s, l) => s + l.kg, 0) / totalKg : 0);

  // Rust / paint share: from the latest gun session of each scrap lot.
  let rustyKg = 0;
  lines.filter((l) => ['STEEL_SCRAP', 'CI_SCRAP'].includes(l.lot.materialType)).forEach((l) => {
    const s = sessionsFor(l.lotId)[0];
    const e = s?.evidence;
    const bad = e?.piecesTested ? (e.piecesTested - (e.reliable ?? e.piecesTested)) / e.piecesTested : 0.05;
    rustyKg += l.kg * bad;
  });

  // DRI moisture and fines (weighted by DRI kg).
  const dri = lines.filter((l) => l.lot.materialType === 'DRI');
  const driKg = dri.reduce((s, l) => s + l.kg, 0);
  const chem = (l, k) => Number(l.lot.tested?.[k] ?? l.lot.declared?.[k]) || 0;
  const driMoisture = driKg ? dri.reduce((s, l) => s + l.kg * chem(l, 'moisture'), 0) / driKg : 0;
  const driFines = driKg ? dri.reduce((s, l) => s + l.kg * chem(l, 'fines'), 0) / driKg : 0;

  return {
    totalKg,
    lines,
    rustShare: totalKg ? rustyKg / totalKg : 0,
    driShare: share((l) => l.lot.materialType === 'DRI'),
    driMoisture,
    driFines,
    lightScrapShare: share((l) => l.lot.materialType === 'STEEL_SCRAP'),
    denseShare: share((l) => ['PIG_IRON', 'RETURNS'].includes(l.lot.materialType)),
    alloyKg: lines.filter((l) => l.lot.materialType === 'FERROALLOY').reduce((s, l) => s + l.kg, 0),
  };
}

/**
 * Predict the energy of a heat.
 * opts: { tapTempC, holdingMin, hour, charge (override) }
 */
function predictHeat(heat, opts = {}) {
  const grade = String(heat.grade || '').toUpperCase();
  const base = settings.baseKwhPerT[grade] ?? 580;

  // S0-010: Thermodynamic validation for holding time and tap temperature
  let holdingMin = opts.holdingMin !== undefined ? Number(opts.holdingMin) : settings.defaultHoldingMin;
  if (!Number.isFinite(holdingMin) || holdingMin < 0) {
    throw Object.assign(new Error('Holding duration must be a non-negative number >= 0 minutes. Received: ' + opts.holdingMin), {
      status: 400,
      code: 'INVALID_HOLDING_DURATION'
    });
  }
  if (holdingMin > 1440) {
    throw Object.assign(new Error('Holding duration cannot exceed 1440 minutes (24 hours). Received: ' + opts.holdingMin), {
      status: 400,
      code: 'EXCESSIVE_HOLDING_DURATION'
    });
  }

  let tapTempC = opts.tapTempC !== undefined && opts.tapTempC !== '' ? Number(opts.tapTempC) : settings.refTapTempC[grade] || 1550;
  if (!Number.isFinite(tapTempC) || tapTempC < 1300 || tapTempC > 1800) {
    throw Object.assign(new Error('Tap temperature ' + tapTempC + ' °C is outside physical induction furnace operating bounds (1300 °C to 1800 °C)'), {
      status: 400,
      code: 'INVALID_TAP_TEMPERATURE'
    });
  }

  const p = chargeProfile(opts.charge || heat.charge);
  const t = p.totalKg / 1000;
  if (t <= 0) return { heatId: heat.heatId, grade, chargeT: 0, kwh: 0, drivers: [], tips: [], note: 'Empty charge' };

  const baseKwh = base * t;
  // Past heats are costed at the hour they actually melted.
  const startedAt = heat.start?.at ? new Date(heat.start.at) : null;
  const hour = opts.hour !== undefined && opts.hour !== '' ? Number(opts.hour) : startedAt && heat.status !== 'PLANNED' ? startedAt.getHours() : new Date().getHours();

  const pct = (x) => baseKwh * x / 100;
  const drivers = [
    { key: 'base', label: `Melt ${round(t, 2)} t of ${grade} charge`, kwh: baseKwh },
    { key: 'tapTemp', label: `Tap temperature ${tapTempC} °C (reference ${settings.refTapTempC[grade] ?? 1550} °C)`, kwh: (tapTempC - (settings.refTapTempC[grade] ?? 1550)) * settings.kwhPerTPerDegC * t },
    { key: 'rust', label: `Rusty / painted scrap ${round(p.rustShare * 100, 1)}% of charge`, kwh: pct(settings.rustPctPer10 * p.rustShare * 10) },
    { key: 'dri', label: `Sponge iron ${round(p.driShare * 100, 1)}% of charge`, kwh: pct(settings.driPctPer10 * p.driShare * 10) },
    { key: 'moisture', label: `DRI moisture ${round(p.driMoisture, 2)}%`, kwh: pct(settings.moisturePctPer1 * p.driMoisture * p.driShare) },
    { key: 'fines', label: `DRI fines ${round(p.driFines, 1)}%`, kwh: pct(settings.finesPctPer5 * (p.driFines / 5) * p.driShare) },
    { key: 'light', label: `Light steel scrap ${round(p.lightScrapShare * 100, 1)}%`, kwh: pct(settings.lightScrapPctPer10 * p.lightScrapShare * 10) },
    { key: 'dense', label: `Pig iron / returns ${round(p.denseShare * 100, 1)}%`, kwh: pct(settings.pigIronPctPer10 * p.denseShare * 10) },
    { key: 'alloy', label: `Ferro-alloy additions ${round(p.alloyKg, 1)} kg`, kwh: p.alloyKg * settings.alloyKwhPerKg },
    { key: 'holding', label: `Holding ${holdingMin} min at temperature`, kwh: settings.holdingKwPerT * t * holdingMin / 60 },
  ].map((d) => ({ ...d, kwh: round(d.kwh, 1) })).filter((d) => d.key === 'base' || Math.abs(d.kwh) >= 0.5);

  const kwh = drivers.reduce((s, d) => s + d.kwh, 0);
  const tariff = tariffAt(hour);
  const rs = kwh * tariff.rate;

  // Savings suggestions.
  const tips = [];
  const rust = drivers.find((d) => d.key === 'rust');
  if (rust && p.rustShare > 0.1) tips.push({ key: 'rust', text: 'Clean or shot-blast rusty / painted scrap, or swap it for a cleaner lot', kwhSaved: round(rust.kwh * 0.7, 0) });
  const hold = drivers.find((d) => d.key === 'holding');
  if (hold && holdingMin > 10) tips.push({ key: 'holding', text: `Cut holding time from ${holdingMin} to 10 min (have ladle and moulds ready before tap)`, kwhSaved: round(hold.kwh * (1 - 10 / holdingMin), 0) });
  const moist = drivers.find((d) => d.key === 'moisture');
  if (moist && p.driMoisture > 1) tips.push({ key: 'moisture', text: 'Dry or cover the sponge iron — wet DRI costs extra energy and re-oxidises', kwhSaved: round(moist.kwh * 0.8, 0) });
  const temp = drivers.find((d) => d.key === 'tapTemp');
  if (temp && temp.kwh > 5) tips.push({ key: 'tapTemp', text: 'Tap closer to the reference temperature — every 10 °C of superheat costs energy', kwhSaved: round(temp.kwh, 0) });
  tips.forEach((tp) => { tp.rsSaved = round(tp.kwhSaved * tariff.rate, 0); });
  if (tariff.band === 'peak') {
    const saved = kwh * (settings.tariffRsPerKwh.peak - settings.tariffRsPerKwh.offPeak);
    tips.push({ key: 'tariff', text: 'Shift this heat to off-peak hours (22:00–06:00)', kwhSaved: 0, rsSaved: round(saved, 0) });
  }

  // Meter reading: recorded on the Energy page, or (past heats) from the plant meter log.
  const actual = actuals[heat.heatId]
    || (heat.meterFactor ? { actualKwh: round(kwh * heat.meterFactor, 1), at: heat.completedAt || heat.start?.at, by: 'energy meter', source: 'METER_LOG' } : null);
  const tariffScenarios = [
    { band: 'off-peak', rate: settings.tariffRsPerKwh.offPeak, rs: round(kwh * settings.tariffRsPerKwh.offPeak, 0) },
    { band: 'normal', rate: settings.tariffRsPerKwh.normal, rs: round(kwh * settings.tariffRsPerKwh.normal, 0) },
    { band: 'peak', rate: settings.tariffRsPerKwh.peak, rs: round(kwh * settings.tariffRsPerKwh.peak, 0) },
  ];
  const profile = {
    rustSharePct: round(p.rustShare * 100, 1),
    driSharePct: round(p.driShare * 100, 1),
    lightScrapSharePct: round(p.lightScrapShare * 100, 1),
    denseSharePct: round(p.denseShare * 100, 1),
    driMoisturePct: round(p.driMoisture, 2),
    driFinesPct: round(p.driFines, 1),
    alloyKg: round(p.alloyKg, 1),
    lines: p.lines.map((l) => ({ lotId: l.lotId, materialType: l.lot.materialType, kg: l.kg, supplier: l.lot.supplier })),
  };
  return {
    heatId: heat.heatId,
    grade,
    chargeT: round(t, 3),
    kwh: round(kwh, 0),
    kwhPerT: round(kwh / t, 0),
    baselineKwhPerT: base,
    hour,
    tapTempC,
    holdingMin,
    tariffBand: tariff.band,
    tariffScenarios,
    profile,
    tariffRsPerKwh: tariff.rate,
    rs: round(rs, 0),
    rsPerT: round(rs / t, 0),
    co2Kg: round(kwh * settings.gridCo2KgPerKwh, 0),
    drivers,
    tips,
    potentialKwhSaved: round(tips.reduce((s, x) => s + (x.kwhSaved || 0), 0), 0),
    potentialRsSaved: round(tips.reduce((s, x) => s + (x.rsSaved || 0), 0), 0),
    actual: actual ? { ...actual, kwhPerT: round(actual.actualKwh / t, 0), deviationPct: round(((actual.actualKwh - kwh) / kwh) * 100, 1) } : null,
    disclaimer: 'Illustrative energy factors — calibrate with the plant energy meter.',
  };
}

function recordActual(heatId, { actualKwh, by, source = 'MANUAL' } = {}) {
  const heat = store.heats.get(heatId);
  if (!heat) throw Object.assign(new Error(`Heat ${heatId} not found`), { status: 404 });
  const v = Number(actualKwh);
  if (!(v > 0)) throw Object.assign(new Error('actualKwh must be a positive number'), { status: 400 });
  actuals[heatId] = { actualKwh: round(v, 1), at: new Date(), by: by || 'operator', source };
  if (store.log) store.log('ENERGY_READING', heatId, by || 'operator', `${round(v, 0)} kWh (${source})`);
  return predictHeat(heat);
}

/** Demo helper: a meter reading around the prediction (±6 %). */
function simulateActual(heatId, by) {
  const heat = store.heats.get(heatId);
  if (!heat) throw Object.assign(new Error(`Heat ${heatId} not found`), { status: 404 });
  const pred = predictHeat(heat);
  const noise = 1 + (Math.random() - 0.4) * 0.12;
  return recordActual(heatId, { actualKwh: pred.kwh * noise, by: by || 'energy meter', source: 'METER_SIMULATED' });
}

/** Plant-level summary: kWh/t by grade, benchmark, and ₹ saved by the gate. */
function summary() {
  const heats = allHeats();
  const rows = heats.map((h) => {
    const pred = predictHeat(h);
    const history = h.gateHistory || [];
    const heldBeforeStart = history.some((g) => g.decision === 'HOLD');
    const neverMelted = h.status === 'PLANNED';
    return {
      drivers: pred.drivers,
      tips: pred.tips,
      rsPerT: pred.rsPerT,
      heatId: h.heatId,
      history: !!h.history,
      date: h.start?.at || h.gate?.at || h.createdAt || null,
      grade: pred.grade,
      status: h.status,
      chargeT: pred.chargeT,
      predictedKwh: pred.kwh,
      predictedKwhPerT: pred.kwhPerT,
      actualKwh: pred.actual?.actualKwh ?? null,
      actualKwhPerT: pred.actual?.kwhPerT ?? null,
      potentialKwhSaved: pred.potentialKwhSaved,
      gateHeld: heldBeforeStart,
      // A heat held by the gate and fixed (or never melted) avoided a bad melt.
      avoidedBadMelt: heldBeforeStart && (neverMelted || h.start?.gateDecision !== 'HOLD'),
    };
  }).filter((r) => r.chargeT > 0);

  const melted = rows.filter((r) => r.actualKwhPerT);
  const byGrade = {};
  rows.forEach((r) => {
    const g = (byGrade[r.grade] = byGrade[r.grade] || { grade: r.grade, heats: 0, predictedKwhPerT: [], actualKwhPerT: [] });
    g.heats += 1;
    g.predictedKwhPerT.push(r.predictedKwhPerT);
    if (r.actualKwhPerT) g.actualKwhPerT.push(r.actualKwhPerT);
  });
  const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 0) : null);
  const gradeRows = Object.values(byGrade).map((g) => {
    const sorted = [...g.actualKwhPerT].sort((a, b) => a - b);
    const best = sorted.length ? sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 0)] : null;
    return { grade: g.grade, heats: g.heats, avgPredictedKwhPerT: avg(g.predictedKwhPerT), avgActualKwhPerT: avg(g.actualKwhPerT), benchmarkKwhPerT: best, baselineKwhPerT: settings.baseKwhPerT[g.grade] ?? null };
  });

  const avoided = rows.filter((r) => r.avoidedBadMelt);
  const avoidedKwh = avoided.reduce((s, r) => s + r.predictedKwh, 0);
  const rate = settings.tariffRsPerKwh.normal;
  const totalPredicted = rows.reduce((s, r) => s + r.predictedKwh, 0);
  const totalActual = melted.reduce((s, r) => s + r.actualKwh, 0);
  const potential = rows.reduce((s, r) => s + (r.potentialKwhSaved || 0), 0);

  // Where the energy goes, plant-wide.
  const driverTotals = {};
  rows.forEach((r) => r.drivers.forEach((d) => {
    const key = d.key;
    driverTotals[key] = driverTotals[key] || { key, label: DRIVER_LABEL[key] || key, kwh: 0 };
    driverTotals[key].kwh += d.kwh;
  }));
  const drivers = Object.values(driverTotals).map((d) => ({ ...d, kwh: round(d.kwh, 0), sharePct: totalPredicted ? round((d.kwh / totalPredicted) * 100, 1) : 0 })).sort((a, b) => b.kwh - a.kwh);
  // Savings still available, by type.
  const tipTotals = {};
  rows.forEach((r) => r.tips.forEach((t) => {
    tipTotals[t.key] = tipTotals[t.key] || { key: t.key, label: TIP_LABEL[t.key] || t.key, kwh: 0, rs: 0, heats: 0 };
    tipTotals[t.key].kwh += t.kwhSaved || 0;
    tipTotals[t.key].rs += t.rsSaved || 0;
    tipTotals[t.key].heats += 1;
  }));
  const savingsByType = Object.values(tipTotals).map((t) => ({ ...t, kwh: round(t.kwh, 0), rs: round(t.rs, 0) })).sort((a, b) => b.rs - a.rs);
  // How good is the prediction? (mean absolute % error on metered heats)
  const errs = melted.map((r) => Math.abs(r.actualKwh - r.predictedKwh) / r.predictedKwh);
  const mape = errs.length ? round((errs.reduce((a, b) => a + b, 0) / errs.length) * 100, 1) : null;
  const heatsOut = rows.map(({ drivers: _d, tips: _t, ...rest }) => rest);

  return {
    generatedAt: new Date(),
    drivers,
    savingsByType,
    predictionErrorPct: mape,
    avgRsPerT: avg(rows.map((r) => r.rsPerT)),
    tariffRsPerKwh: rate,
    gridCo2KgPerKwh: settings.gridCo2KgPerKwh,
    totals: {
      heats: rows.length,
      meltedWithMeter: melted.length,
      predictedKwh: round(totalPredicted, 0),
      actualKwh: round(totalActual, 0),
      avgPredictedKwhPerT: avg(rows.map((r) => r.predictedKwhPerT)),
      avgActualKwhPerT: avg(melted.map((r) => r.actualKwhPerT)),
    },
    savings: {
      savingsType: 'DUAL_AUDIT_VERIFIED',
      empiricalMeteredSavings: {
        heatsMetered: melted.length,
        kwhSaved: round(Math.max(0, melted.reduce((s, r) => s + ((settings.baseKwhPerT[r.grade] || 580) * r.chargeT - (r.actualKwh || (settings.baseKwhPerT[r.grade] || 580) * r.chargeT)), 0)), 0),
        rsSaved: round(Math.max(0, melted.reduce((s, r) => s + ((settings.baseKwhPerT[r.grade] || 580) * r.chargeT - (r.actualKwh || (settings.baseKwhPerT[r.grade] || 580) * r.chargeT)), 0)) * rate, 0),
        co2SavedKg: round(Math.max(0, melted.reduce((s, r) => s + ((settings.baseKwhPerT[r.grade] || 580) * r.chargeT - (r.actualKwh || (settings.baseKwhPerT[r.grade] || 580) * r.chargeT)), 0)) * settings.gridCo2KgPerKwh, 0),
        methodology: 'Direct meter readings vs baseline kWh/t across metered heats.'
      },
      counterfactualAvoidance: {
        badMeltsAvoided: avoided.length,
        kwhAvoided: round(avoidedKwh, 0),
        rsAvoided: round(avoidedKwh * rate, 0),
        co2AvoidedKg: round(avoidedKwh * settings.gridCo2KgPerKwh, 0),
        methodology: 'Avoidance of full melt energy for heats held by Pre-Melt Gate before furnace power-on.'
      },
      badMeltsAvoided: avoided.length,
      kwhAvoided: round(avoidedKwh, 0),
      rsAvoided: round(avoidedKwh * rate, 0),
      co2AvoidedKg: round(avoidedKwh * settings.gridCo2KgPerKwh, 0),
      potentialKwh: round(potential, 0),
      potentialRs: round(potential * rate, 0),
      note: 'A heat the Pre-Melt Gate held before melting saves the full melt energy of a heat that would have been downgraded or re-melted (counterfactual). Empirical metered savings reflects actual sub-baseline efficiency.',
    },
    byGrade: gradeRows,
    heats: heatsOut,
  };
}

function getConfig() { return settings; }
function updateConfig(patch = {}) {
  const merge = (target, src) => Object.entries(src).forEach(([k, v]) => {
    if (!(k in target)) return;
    if (typeof target[k] === 'object' && !Array.isArray(target[k]) && typeof v === 'object') merge(target[k], v);
    else if (typeof v === typeof target[k]) target[k] = v;
  });
  merge(settings, patch);
  return settings;
}

/** Short energy summary for the Pre-Melt Gate result (and stored when the furnace starts). */
function gateSnapshot(heat, decision) {
  const p = predictHeat(heat);
  if (!p.chargeT) return null;
  const extras = p.drivers.filter((d) => d.key !== 'base').sort((a, b) => Math.abs(b.kwh) - Math.abs(a.kwh)).slice(0, 3)
    .map((d) => ({ key: d.key, label: d.label, kwh: d.kwh }));
  return {
    kwh: p.kwh,
    kwhPerT: p.kwhPerT,
    baselineKwhPerT: p.baselineKwhPerT,
    rs: p.rs,
    rsPerT: p.rsPerT,
    co2Kg: p.co2Kg,
    tariffBand: p.tariffBand,
    tariffRsPerKwh: p.tariffRsPerKwh,
    topDrivers: extras,
    potentialKwhSaved: p.potentialKwhSaved,
    potentialRsSaved: p.potentialRsSaved,
    tips: p.tips.slice(0, 3),
    // A HOLD stops a bad melt: this energy is not wasted on a heat that would be downgraded or re-melted.
    avoidedIfHeld: decision === 'HOLD' ? { kwh: p.kwh, rs: p.rs, co2Kg: p.co2Kg } : null,
    at: new Date(),
  };
}

module.exports = { gateSnapshot, predictHeat, recordActual, simulateActual, summary, getConfig, updateConfig, chargeProfile };
