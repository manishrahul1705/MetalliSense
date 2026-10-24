import React from "react";
import clsx from "clsx";

export const LOT_STATUS = {
  RELEASED: { label: "Released", cls: "bg-primary-100 text-primary-800 border-primary-300" },
  RESTRICTED: { label: "Restricted", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  AWAITING_QA: { label: "Awaiting QA", cls: "bg-sky-100 text-sky-800 border-sky-300" },
  PROVISIONAL: { label: "Provisional", cls: "bg-indigo-100 text-indigo-800 border-indigo-300" },
  QUARANTINED: { label: "Quarantined", cls: "bg-red-100 text-red-800 border-red-300" },
  REJECTED: { label: "Rejected", cls: "bg-red-200 text-red-900 border-red-400" },
  CONSUMED: { label: "Consumed", cls: "bg-metal-100 text-metal-600 border-metal-300" },
};

export const CHECK_STATUS = {
  PASS: { label: "Pass", cls: "bg-primary-100 text-primary-800", dot: "bg-primary-500" },
  WARN: { label: "Warn", cls: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  FAIL: { label: "Fail", cls: "bg-red-100 text-red-800", dot: "bg-red-500" },
  SKIP: { label: "N/A", cls: "bg-metal-100 text-metal-500", dot: "bg-metal-300" },
};

export const SOURCE_LABEL = {
  DECLARED: "Supplier declared",
  CERTIFICATE: "Mill certificate",
  LAB: "QA lab",
  PARENT_HEAT: "Parent heat OES",
};

export const MATERIAL_LABEL = {
  STEEL_SCRAP: "Steel scrap",
  CI_SCRAP: "Cast iron scrap",
  PIG_IRON: "Pig iron",
  DRI: "Sponge iron (DRI)",
  RETURNS: "Foundry returns",
  FERROALLOY: "Alloy additive",
};

export const kg = (v) =>
  v === null || v === undefined ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 1 })} kg`;

export const errMsg = (err, fallback = "Request failed") => {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const message = data?.message || data?.error;
  const code = data?.code;

  if (status === 409) {
    if (code === 'VERSION_CONFLICT' || message?.toLowerCase().includes('concurrency') || message?.toLowerCase().includes('expected version')) {
      return `Conflict: This record was updated by another user or process. Please refresh and try again. (${message || 'Version mismatch'})`;
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      return 'Duplicate operation: A different request already used this idempotency key.';
    }
    if (code === 'CERTIFICATE_INELIGIBLE') {
      return `Certificate Ineligible: ${message}`;
    }
  }

  if (status === 403 && (code === 'GATE_BYPASS_FORBIDDEN' || message?.toLowerCase().includes('resume'))) {
    return 'Security Violation: Bypassing the Pre-Melt Gate is strictly forbidden. Heats must follow authorized workflow stages.';
  }

  if (status === 423) {
    return `Locked: ${message || 'This operation is locked by the pre-melt gate'}`;
  }

  if (status === 428) {
    return `Precondition Required: ${message || 'Please complete prerequisite verification first'}`;
  }

  if (status === 422) {
    return `Validation Failed: ${message || 'Invalid parameters supplied'}`;
  }

  if (err?.code === 'ECONNABORTED' || message?.toLowerCase().includes('timeout')) {
    return 'Request timed out. Please check your connection and retry.';
  }

  return message || (err?.code === 'ERR_NETWORK' ? 'Backend not reachable on :3000' : err?.message) || fallback;
};

export const HEAT_STATUS = {
  PLANNED: { label: "Planned", cls: "bg-metal-100 text-metal-800 border-metal-300", dot: "bg-metal-400" },
  GATE_EVALUATED: { label: "Gate Evaluated", cls: "bg-sky-100 text-sky-800 border-sky-300", dot: "bg-sky-500" },
  MELTING: { label: "Melting", cls: "bg-orange-100 text-orange-800 border-orange-300", dot: "bg-orange-500 animate-pulse" },
  AWAITING_MEASURED_CHEMISTRY: { label: "Awaiting Chemistry", cls: "bg-indigo-100 text-indigo-800 border-indigo-300", dot: "bg-indigo-500" },
  CORRECTION_PENDING: { label: "Correction Pending", cls: "bg-yellow-100 text-yellow-800 border-yellow-300", dot: "bg-yellow-500" },
  QUALITY_REVIEW: { label: "Quality Review", cls: "bg-purple-100 text-purple-800 border-purple-300", dot: "bg-purple-500" },
  COMPLETED: { label: "Completed", cls: "bg-teal-100 text-teal-800 border-teal-300", dot: "bg-teal-500" },
  HELD: { label: "Held", cls: "bg-amber-100 text-amber-800 border-amber-300", dot: "bg-amber-500" },
  RELEASED: { label: "Released", cls: "bg-emerald-100 text-emerald-800 border-emerald-300", dot: "bg-emerald-500" },
  REJECTED: { label: "Rejected", cls: "bg-red-100 text-red-800 border-red-300", dot: "bg-red-500" },
};

export function HeatStatusPill({ status, className }) {
  const s = HEAT_STATUS[status] || { label: status, cls: "bg-metal-100 text-metal-700 border-metal-300", dot: "bg-metal-400" };
  return (
    <span className={clsx("inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap", s.cls, className)}>
      <span className={clsx("w-1.5 h-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function StatusPill({ status, className }) {
  const s = LOT_STATUS[status] || { label: status, cls: "bg-metal-100 text-metal-700 border-metal-300" };
  return (
    <span className={clsx("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap", s.cls, className)}>
      {s.label}
    </span>
  );
}

export function CheckPill({ status }) {
  const s = CHECK_STATUS[status] || CHECK_STATUS.SKIP;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold", s.cls)}>
      <span className={clsx("w-1.5 h-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={clsx("block", className)}>
      <span className="block text-xs font-semibold text-metal-700 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-metal-500 mt-1">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full px-3 py-2 border-2 border-metal-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500";

/**
 * Predicted value with its ±2σ band against the spec range.
 * For max-only elements pass min = null.
 */
export function ChemBar({ element, value, sigma = 0, min, max, band = 2, status }) {
  const lo = value - band * sigma;
  const hi = value + band * sigma;
  const lowEdge = Math.min(min ?? 0, lo);
  const highEdge = Math.max(max ?? value, hi);
  const pad = (highEdge - lowEdge) * 0.25 || 0.01;
  const low = Math.max(0, lowEdge - pad);
  const high = highEdge + pad;
  const pos = (v) => `${Math.max(0, Math.min(100, ((v - low) / (high - low)) * 100))}%`;
  const color = status === "FAIL" ? "bg-red-600" : status === "WARN" ? "bg-amber-500" : "bg-primary-600";
  return (
    <div className="grid grid-cols-[3rem_1fr_7.5rem] items-center gap-3 py-1.5">
      <span className="font-mono font-bold text-metal-800 text-sm">{element}</span>
      <div className="relative h-5 rounded bg-metal-100" role="img" aria-label={`${element} ${value}%, limits ${min ?? 0} to ${max}%`}>
        <div className="absolute inset-y-0 bg-primary-100 border-x-2 border-primary-400" style={{ left: pos(min ?? 0), width: `calc(${pos(max)} - ${pos(min ?? 0)})` }} />
        <div className={clsx("absolute top-1.5 h-2 rounded-full opacity-40", color)} style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        <div className={clsx("absolute top-0 h-5 w-1 rounded", color)} style={{ left: pos(value) }} />
      </div>
      <span className="text-xs text-metal-700 text-right tabular-nums">
        <strong>{Number(value).toFixed(3)}</strong> ± {(band * sigma).toFixed(3)}
        <span className="block text-[11px] text-metal-500">{min !== null && min !== undefined ? `${min}–${max}` : `max ${max}`}%</span>
      </span>
    </div>
  );
}
