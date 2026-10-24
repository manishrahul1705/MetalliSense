/**
 * MeltFlowContext
 *
 * Shared state that carries one heat through the entire post-gate flow:
 *   Pre-Melt Gate → Anomaly Detection → Alloy Recommendation → RL Optimizer
 *
 * Rules enforced here:
 * 1. The AI pages (Anomaly, Alloy, RL) are LOCKED until a heat has passed the gate
 *    (decision GO, or HOLD that was overridden with a written reason).
 * 2. The composition fed into the AI pages comes from the gate's predicted
 *    melt-down chemistry, not from the synthetic generator.
 * 3. Stock is deducted ONLY after the operator accepts a strategy from the RL
 *    Optimizer (thumbs-up). Before that the lots are merely "reserved" so the
 *    gate can verify stock but nothing is removed from the ledger.
 * 4. When the operator rejects all RL strategies the gate must be re-run with
 *    a different charge.
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer } from 'react';

// Persist the active heat across page refreshes (per browser tab).
const STORAGE_KEY = 'metallisense.meltFlow.v1';
function loadInitial(initial) {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? { ...initial, ...JSON.parse(raw) } : initial;
  } catch {
    return initial;
  }
}

// ------------------------------------------------------------------ shape
const INITIAL = {
  // The heat that passed the gate
  heatId: null,
  grade: null,
  status: null,
  version: null,
  targetKg: null,
  chargeKg: null,
  metalKg: null,

  // The gate result that unlocked this flow
  suggestedAdditions: [],   // from gate: [{ element, lotId, kg, alloyName, cost }]
  gateId: null,
  gateDecision: null,   // 'GO' | 'WARN' | 'HOLD' (overridden)
  overriddenBy: null,   // engineer name if HOLD override
  passedAt: null,       // timestamp the gate was cleared

  // Predicted melt-down composition and uncertainty from the gate
  // This is what flows into Anomaly → Alloy → RL
  predictedComposition: null,   // { C, Si, Mn, P, S, Fe, Cu, Cr, Ni, Mo, Sn }
  compositionSigma: null,       // ±1σ per element
  gateSpec: null,               // { ranges: {C:[lo,hi], ...} } grade spec used by gate
  deviationElements: [],        // elements that were outside spec or flagged by gate
  gateChecks: [],               // full check results from gate for context

  // AI page results (filled as the flow progresses)
  anomalyResult: null,
  alloyResult: null,
  rlResult: null,

  // The RL strategy the operator accepted
  acceptedStrategy: null,   // { strategy, recommended_additions, estimatedCost, … }

  // Stock deduction: 'pending' | 'deducted' | null
  stockStatus: null,

  // Mechanical property prediction
  mechResult: null,
  tapApproved: false,
};

// ------------------------------------------------------------------ reducer
function reducer(state, action) {
  switch (action.type) {
    case 'GATE_PASSED':
      return {
        ...INITIAL,
        heatId: action.heatId,
        grade: action.grade,
        status: action.status || 'MELTING',
        version: action.version ?? 1,
        targetKg: action.targetKg,
        chargeKg: action.chargeKg,
        metalKg: action.metalKg,
        gateId: action.gateId,
        gateDecision: action.gateDecision,
        overriddenBy: action.overriddenBy || null,
        passedAt: new Date().toISOString(),
        predictedComposition: action.predictedComposition,
        compositionSigma: action.compositionSigma,
        suggestedAdditions: action.suggestedAdditions || [],
        gateSpec: action.gateSpec || null,
        deviationElements: action.deviationElements || [],
        gateChecks: action.gateChecks || [],
        stockStatus: 'pending',
      };
    case 'ANOMALY_DONE':
      return { ...state, anomalyResult: action.result };
    case 'ALLOY_DONE':
      return { ...state, alloyResult: action.result };
    case 'RL_DONE':
      return { ...state, rlResult: action.result };
    case 'STRATEGY_ACCEPTED':
      return { ...state, acceptedStrategy: action.strategy, stockStatus: 'deducted' };
    case 'MECH_DONE':
      return { ...state, mechResult: action.result };
    case 'TAP_APPROVED':
      return { ...state, tapApproved: true };
    case 'UPDATE_SERVER_HEAT':
      return {
        ...state,
        ...(action.status ? { status: action.status } : {}),
        ...(action.version !== undefined ? { version: action.version } : {}),
      };
    case 'STRATEGY_REJECTED':
      // All strategies rejected → clear RL result so the operator must re-run
      return { ...state, rlResult: null, acceptedStrategy: null };
    case 'RESET':
      return INITIAL;
    default:
      return state;
  }
}

// ------------------------------------------------------------------ context
const MeltFlowContext = createContext(null);

export function MeltFlowProvider({ children }) {
  const [flow, dispatch] = useReducer(reducer, INITIAL, loadInitial);

  useEffect(() => {
    try {
      if (flow.heatId) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(flow));
      else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable — flow still works in memory */ }
  }, [flow]);

  // Called by PreMeltGate when Start Melting succeeds
  const gatePassed = useCallback((heat, gateResult) => {
    const pred = gateResult.prediction;
    // Compute which elements are outside the grade spec or close to a limit
    const specRanges = gateResult.spec?.ranges || {};
    const comp = pred?.composition || {};
    const sigma = pred?.sigma || {};
    const deviationElements = Object.entries(specRanges)
      .filter(([el, [lo, hi]]) => {
        const v = comp[el]; if (v === undefined) return false;
        const s2 = sigma[el] || 0;
        const outSpec = (lo !== null && v < lo) || v > hi;
        const nearLimit = v + 2 * s2 > hi || (lo !== null && v - 2 * s2 < lo);
        return outSpec || nearLimit;
      })
      .map(([el]) => el);

    dispatch({
      type: 'GATE_PASSED',
      heatId: heat.heatId,
      grade: heat.grade,
      status: heat.status || 'MELTING',
      version: heat.version,
      targetKg: heat.targetKg,
      chargeKg: pred?.chargeKg ?? null,
      metalKg: pred?.metalKg ?? null,
      gateId: gateResult.gateId,
      gateDecision: gateResult.decision,
      overriddenBy: heat.start?.override?.engineer ?? null,
      predictedComposition: pred?.composition ?? null,
      compositionSigma: pred?.sigma ?? null,
      suggestedAdditions: gateResult.suggestedAdditions ?? [],
      gateSpec: gateResult.spec || null,
      deviationElements,
      gateChecks: gateResult.checks || [],
    });
  }, []);

  const anomalyDone  = useCallback((r)  => dispatch({ type: 'ANOMALY_DONE',  result: r }), []);
  const alloyDone    = useCallback((r)  => dispatch({ type: 'ALLOY_DONE',    result: r }), []);
  const rlDone       = useCallback((r)  => dispatch({ type: 'RL_DONE',       result: r }), []);
  const acceptStrategy = useCallback((s) => dispatch({ type: 'STRATEGY_ACCEPTED', strategy: s }), []);
  const rejectAll      = useCallback(()  => dispatch({ type: 'STRATEGY_REJECTED' }), []);
  const mechDone       = useCallback((r) => dispatch({ type: 'MECH_DONE', result: r }), []);
  const approveTap     = useCallback(()  => dispatch({ type: 'TAP_APPROVED' }), []);
  const updateServerHeat = useCallback((h) => {
    if (!h) return;
    dispatch({ type: 'UPDATE_SERVER_HEAT', status: h.status, version: h.version });
  }, []);
  const reset          = useCallback(()  => dispatch({ type: 'RESET' }), []);

  // Convenience: is the flow unlocked?
  const isUnlocked = !!flow.heatId;

  // Which AI step can the user run right now?
  const canRunAnomaly = isUnlocked;
  const canRunAlloy   = isUnlocked && !!flow.anomalyResult;
  const canRunRL      = isUnlocked && !!flow.alloyResult;
  const canAccept     = isUnlocked && !!flow.rlResult && flow.stockStatus === 'pending';
  const canRunMech    = isUnlocked && flow.stockStatus === 'deducted';

  return (
    <MeltFlowContext.Provider value={{
      flow, isUnlocked,
      canRunAnomaly, canRunAlloy, canRunRL, canAccept, canRunMech,
      gatePassed, updateServerHeat, anomalyDone, alloyDone, rlDone,
      acceptStrategy, rejectAll, mechDone, approveTap, reset,
    }}>
      {children}
    </MeltFlowContext.Provider>
  );
}

export function useMeltFlow() {
  const ctx = useContext(MeltFlowContext);
  if (!ctx) throw new Error('useMeltFlow must be used inside MeltFlowProvider');
  return ctx;
}
