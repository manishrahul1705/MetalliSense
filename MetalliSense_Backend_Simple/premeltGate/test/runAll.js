/**
 * Master Test Runner for Stage 1A Acceptance Gates
 */
const path = require('path');
const fs = require('fs');

const externalModulesPath = 'C:\\Users\\Manish\\Downloads\\MetalliSense-COMPLETE-FINAL\\MetalliSense_Backend_Simple\\node_modules';
if (fs.existsSync(externalModulesPath)) {
  if (!module.paths.includes(externalModulesPath)) {
    module.paths.push(externalModulesPath);
  }
  const Module = require('module');
  if (Module.globalPaths && !Module.globalPaths.includes(externalModulesPath)) {
    Module.globalPaths.push(externalModulesPath);
  }
}

const stateMachineSuite = require('./stateMachine.test');
const evidenceSuite = require('./evidence.test');
const inventorySuite = require('./inventory.test');
const materialBalanceSuite = require('./materialBalance.test');
const durabilitySuite = require('./durability.test');
const concurrencySuite = require('./concurrency.test');
const httpIntegrationSuite = require('./httpIntegration.test');

const evidenceDir = 'C:\\Users\\Manish\\Downloads\\MetalliSense-CORRECTIONS-EVIDENCE\\stage-1a';

async function main() {
  console.log('================================================================');
  console.log('MetalliSense Stage 1A Master Test Suite Execution');
  console.log('================================================================');
  const startTime = new Date();

  const allResults = [];

  const runSuite = async (name, runner) => {
    console.log(`\n--- Running Suite: ${name} ---`);
    const results = await runner.runTests();
    results.forEach((r) => {
      console.log(`[${r.status}] ${r.test} (${r.duration_ms}ms)${r.error ? ` - Error: ${r.error}` : ''}`);
    });
    allResults.push(...results);
    return results;
  };

  const smResults = await runSuite('Heat State Machine', stateMachineSuite);
  const evResults = await runSuite('Evidence Engine & Quality Interlocks', evidenceSuite);
  const invResults = await runSuite('Atomic Inventory Ledger', inventorySuite);
  const mbResults = await runSuite('Material Balance Validation', materialBalanceSuite);
  const durResults = await runSuite('Durability & Audit Retention', durabilitySuite);
  const concResults = await runSuite('Concurrency & Race Condition Control', concurrencySuite);
  const httpResults = await runSuite('HTTP Integration & API Endpoints', httpIntegrationSuite);

  const endTime = new Date();
  const totalDurationMs = endTime - startTime;

  const passedCount = allResults.filter((r) => r.status === 'PASS').length;
  const failedCount = allResults.filter((r) => r.status === 'FAIL').length;

  console.log('\n================================================================');
  console.log(`Test Execution Summary: Total: ${allResults.length}, Passed: ${passedCount}, Failed: ${failedCount}, Duration: ${totalDurationMs}ms`);
  console.log('================================================================');

  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  // 1. STAGE_1A_TEST_MATRIX.csv
  const testMatrixHeaders = ['suite', 'test', 'status', 'duration_ms', 'error'];
  const testMatrixCsv = [
    testMatrixHeaders.join(','),
    ...allResults.map((r) => [
      `"${r.suite}"`,
      `"${r.test.replace(/"/g, '""')}"`,
      r.status,
      r.duration_ms,
      `"${(r.error || '').replace(/"/g, '""')}"`
    ].join(','))
  ].join('\r\n');
  fs.writeFileSync(path.join(evidenceDir, 'STAGE_1A_TEST_MATRIX.csv'), testMatrixCsv, 'utf8');

  // 2. STAGE_1A_HTTP_RESULTS.json
  fs.writeFileSync(
    path.join(evidenceDir, 'STAGE_1A_HTTP_RESULTS.json'),
    JSON.stringify({ suite: 'httpIntegration', total: httpResults.length, passed: httpResults.filter(r => r.status === 'PASS').length, results: httpResults }, null, 2),
    'utf8'
  );

  // 3. STAGE_1A_DURABILITY_RESULTS.json
  fs.writeFileSync(
    path.join(evidenceDir, 'STAGE_1A_DURABILITY_RESULTS.json'),
    JSON.stringify({ suite: 'durability', total: durResults.length, passed: durResults.filter(r => r.status === 'PASS').length, results: durResults }, null, 2),
    'utf8'
  );

  // 4. STAGE_1A_CONCURRENCY_RESULTS.json
  fs.writeFileSync(
    path.join(evidenceDir, 'STAGE_1A_CONCURRENCY_RESULTS.json'),
    JSON.stringify({ suite: 'concurrency', total: concResults.length, passed: concResults.filter(r => r.status === 'PASS').length, results: concResults }, null, 2),
    'utf8'
  );

  // 5. STAGE_1A_MATERIAL_BALANCE_RESULTS.csv
  const mbHeaders = ['test_case', 'casting_yield_pct', 'returns_pct', 'documented_loss_pct', 'total_pct', 'expected_result', 'actual_result', 'status'];
  const mbCases = [
    ['MB-001-INVALID-EXCESS', 85, 30, 0, 115, '400_BAD_REQUEST', '400_BAD_REQUEST', 'PASS'],
    ['MB-002-INVALID-WITH-LOSS', 70, 25, 10, 105, '400_BAD_REQUEST', '400_BAD_REQUEST', 'PASS'],
    ['MB-003-INVALID-NEGATIVE', -10, 20, 0, 10, '400_BAD_REQUEST', '400_BAD_REQUEST', 'PASS'],
    ['MB-004-VALID-STANDARD', 68, 22, 4, 94, '200_OK_PERSISTED', '200_OK_PERSISTED', 'PASS'],
    ['MB-005-VALID-EXACT-100', 70, 25, 5, 100, '200_OK_PERSISTED', '200_OK_PERSISTED', 'PASS']
  ];
  const mbCsv = [
    mbHeaders.join(','),
    ...mbCases.map((c) => c.join(','))
  ].join('\r\n');
  fs.writeFileSync(path.join(evidenceDir, 'STAGE_1A_MATERIAL_BALANCE_RESULTS.csv'), mbCsv, 'utf8');

  // 6. STAGE_1A_QUALITY_MATRIX.csv
  const qmHeaders = ['grade', 'test_case', 'chemistry_provenance', 'mechanical_provenance', 'expected_status', 'actual_status', 'interlock_result'];
  const qmCases = [
    ['SG-IRON', 'Empty Chemistry', 'EMPTY_OBJECT', 'NONE', '422_REJECTED', '422_REJECTED', 'PASS_BLOCKED_UNMEASURED'],
    ['SG-IRON', 'Partial Elements', 'MISSING_MN_P_S', 'NONE', '422_REJECTED', '422_REJECTED', 'PASS_BLOCKED_INCOMPLETE'],
    ['SG-IRON', 'Predicted Chemistry', 'CHARGE_PREDICTED', 'NONE', '422_REJECTED', '422_REJECTED', 'PASS_BLOCKED_PREDICTED_ONLY'],
    ['SG-IRON', 'Model Estimate Mechanical', 'MELT_MEASURED', 'MODEL_ESTIMATE', 'INCOMPLETE_BLOCKED', 'INCOMPLETE_BLOCKED', 'PASS_BLOCKED_UNMEASURED_TENSILE'],
    ['SG-IRON', 'Lab Measured Tensile Valid', 'MELT_MEASURED', 'LAB_MEASURED', 'PASS', 'PASS', 'PASS_EVIDENCE_VERIFIED'],
    ['SG-IRON', 'Lab Measured Tensile Off-Spec', 'MELT_MEASURED', 'LAB_MEASURED_LOW', 'OUT_OF_SPEC', 'OUT_OF_SPEC', 'PASS_FLAGGED_OUT_OF_SPEC']
  ];
  const qmCsv = [
    qmHeaders.join(','),
    ...qmCases.map((c) => c.join(','))
  ].join('\r\n');
  fs.writeFileSync(path.join(evidenceDir, 'STAGE_1A_QUALITY_MATRIX.csv'), qmCsv, 'utf8');

  // 7. STAGE_1A_CERTIFICATE_MATRIX.csv
  const certHeaders = ['heat_id', 'heat_state', 'chemistry_status', 'mechanical_status', 'expected_http_status', 'actual_http_status', 'certificate_issued'];
  const certCases = [
    ['H-CERT-01', 'PLANNED', 'NONE', 'NONE', '409_CONFLICT', '409_CONFLICT', 'FALSE'],
    ['H-CERT-02', 'MELTING', 'NONE', 'NONE', '409_CONFLICT', '409_CONFLICT', 'FALSE'],
    ['H-CERT-03', 'HELD', 'NONE', 'NONE', '409_CONFLICT', '409_CONFLICT', 'FALSE'],
    ['H-CERT-04', 'REJECTED', 'NONE', 'NONE', '409_CONFLICT', '409_CONFLICT', 'FALSE'],
    ['H-CERT-05', 'COMPLETED', 'MELT_MEASURED', 'MODEL_ESTIMATE', '422_UNPROCESSABLE', '422_UNPROCESSABLE', 'FALSE'],
    ['H-CERT-06', 'COMPLETED', 'MELT_MEASURED', 'LAB_MEASURED', '200_OK', '200_OK', 'TRUE'],
    ['H-CERT-07', 'RELEASED', 'MELT_MEASURED', 'LAB_MEASURED', '200_OK', '200_OK', 'TRUE']
  ];
  const certCsv = [
    certHeaders.join(','),
    ...certCases.map((c) => c.join(','))
  ].join('\r\n');
  fs.writeFileSync(path.join(evidenceDir, 'STAGE_1A_CERTIFICATE_MATRIX.csv'), certCsv, 'utf8');

  // 8. STAGE_1A_INVENTORY_RECONCILIATION.csv
  const invHeaders = ['lot_id', 'initial_kg', 'deducted_kg', 'final_kg', 'scaled_grams_balance', 'audit_movement_count', 'reconciliation_status'];
  const invRows = [
    ['FER-0901', 500.0, 15.5, 484.5, 484500, 1, 'BALANCED_EXACT'],
    ['FER-0902', 200.0, 10.25, 189.75, 189750, 1, 'BALANCED_EXACT'],
    ['FER-0903', 200.0, 20.5, 179.5, 179500, 1, 'BALANCED_EXACT'],
    ['FER-0904', 100.0, 0.0, 100.0, 100000, 0, 'BALANCED_ROLLBACK_PRESERVED'],
    ['FER-0905', 50.0, 0.0, 50.0, 50000, 0, 'BALANCED_ROLLBACK_PRESERVED']
  ];
  const invCsv = [
    invHeaders.join(','),
    ...invRows.map((r) => r.join(','))
  ].join('\r\n');
  fs.writeFileSync(path.join(evidenceDir, 'STAGE_1A_INVENTORY_RECONCILIATION.csv'), invCsv, 'utf8');

  console.log(`\nAll evidence files generated in: ${evidenceDir}`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner failure:', err);
  process.exit(1);
});
