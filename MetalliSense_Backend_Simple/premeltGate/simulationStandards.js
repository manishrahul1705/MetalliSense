// Prototype specification thresholds, shared by server-owned simulation QA checks.
module.exports = {
  'SG-IRON': { uts_min: 400, ys_min: 250, elong_min: 10, hb_max: 280, ref: 'IS 1865 SG 400/10 (simulation)' },
  'GREY-IRON': { uts_min: 200, hb_max: 280, ref: 'IS 210 FG 200 (simulation)' },
  'LOW-CARBON-STEEL': { uts_min: 370, ys_min: 230, elong_min: 20, hb_max: 200, ref: 'IS 2062 E250 (simulation)' },
  'MEDIUM-CARBON-STEEL': { uts_min: 550, ys_min: 300, elong_min: 10, hb_max: 320, ref: 'IS 1570 C30-C60 (simulation)' },
  'HIGH-CARBON-STEEL': { uts_min: 650, ys_min: 350, elong_min: 5, hb_max: 380, ref: 'IS 1570 C60-C100 (simulation)' }
};
