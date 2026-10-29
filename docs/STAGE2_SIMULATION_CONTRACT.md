# Isolated prototype simulation contract

Simulation requires all of the following server configuration:

```
NODE_ENV=test
METALLISENSE_SIMULATION=true
METALLISENSE_DB_PATH=<new isolated absolute database path>
METALLISENSE_SIMULATION_STORE=<same isolated absolute database path>
```

Production rejects this configuration. Request headers and fields do not select
the execution context. A database is permanently bound to one context at first
initialization. Existing populated databases cannot be adopted as simulation
stores. Reopening a simulation database in operational mode, or vice versa,
fails. Context is carried by database constraints on heats, materials, QA,
evidence, corrections, approvals, movements, receipts and artifacts. Simulation
must use separate accounts and service credentials provisioned in its own store.

Operational chemistry evaluation continues to reject `SIMULATED_MEASURED`.
The operational correction selector excludes simulated samples. The physical
evidence endpoint rejects simulated laboratory submissions in operational mode.
Simulation stores reject physical-evidence submissions and accept chemistry
only through the existing OPC simulator interface. The human requester and the
server instrument origin are recorded separately. Simulated values are never
persisted as `MELT_MEASURED`, `POST_CORRECTION_MEASURED` or `LAB_MEASURED`.

The simulator uses saved charge prediction as its initial bath and the exact
consumed correction quantities for subsequent samples. These are model
assumptions, not physical instrument validation. Samples still travel through
the actual OPC UA server and client. Disconnection must fail acquisition.

Correction candidates are persisted with maker, heat version, sample, quantities
and hash. Independent review checks feasibility and those bindings again;
deduction consumes the review within the inventory transaction. New evidence,
changed quantities, stale heat version and consumed approvals cannot authorize
another deduction. Chemistry samples must be complete and less than 15 minutes
old for simulation correction/release. Final release requires a subsequent
sample after deduction and independent explicitly simulated final laboratory QA.
Simulation QA uses server specification thresholds rather than client-supplied
standards. Numerical evaluation does not change evidence provenance.

Simulation documents bear `SIMULATION — NOT FOR PRODUCTION OR COMMERCIAL USE`.
They are retained as database snapshots, with unique batch/artifact-kind keys.
They are prototype records; no commercial dispatch or external transaction is
authorized by their issuance.

## Deterministic browser fixtures

The UI runner receives these materials; it does not inject lifecycle states:

| Material | Receipt | Charge | Chemistry / basis |
| --- | ---: | ---: | --- |
| Pig iron | 1000 kg | 900 kg | C 4.02%, Si 2.6%, Mn 0.65%, P 0.025%, S 0.015%; Fe balance |
| DRI | 200 kg | 100 kg | Independently reviewed Fe total 92%, Fe metallic 85%, C 1.2%, P 0.02%, S 0.015% |
| FeSi-75 | 100 kg | 1 kg correction | Si 75%, C 0.10%, Mn 0.30%, P 0.030%, S 0.010%, Fe 24.56% |

The existing charge engine applies its documented material yields and elemental
recoveries. The correction engine uses Si/C/Mn recovery 85%, P/S 100%, Fe 95%
for FeSi. The corrected simulated sample assumes complete mixing, no further
reaction beyond those recovery factors, and bath mass increased by dissolved
element mass. The 1 kg FeSi trim moves silicon toward the SG-iron specification
center while remaining inside other chemistry limits. It does not purport to
prove an industrial correction is physically effective.

Final laboratory fixture values are UTS 450 MPa, YS 280 MPa, elongation 12%,
hardness 200 HB. They are explicitly hypothetical passing specimen values for
the simulated SG 400/10 workflow, entered by independent QA. They are neither
model predictions nor measurements of a physical specimen.

ML validity remains **UNVERIFIED**. Hardware remains **PARTIAL / SIMULATED**.
Live explanation remains provider-blocked without legitimate configuration.
Repository lint remains **BLOCKED** until its separate missing configuration
issue is resolved. This contract does not establish Stage F or production readiness.
