import React, { useState, useEffect, useRef } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  GraduationCap,
  AlertTriangle,
  Lightbulb,
  Bot,
  FileCheck,
  Cpu,
  Microscope,
  Database,
  LayoutDashboard,
  Activity,
  LogOut,
  FileText,
  Repeat,
  Sparkles,
  IndianRupee,
  Workflow,
  Boxes,
  ScanLine,
  ShieldCheck,
  Trophy,
  Zap,
  PackageSearch,
  Receipt,
  Gauge,
} from "lucide-react";
import { useMeltFlow } from "../../context/MeltFlowContext";
import logo from "../../assets/Metallisense-logo.png";

const sidebarItems = [
  {
    id: "onboard-tour",
    label: "Onboard Tour",
    icon: GraduationCap,
    isTour: true,
    category: "core",
  },
  {
    id: "technical-docs",
    label: "Technical Documentation",
    icon: FileText,
    isExternalLink: true,
    url: "https://drive.google.com/uc?export=download&id=1t5t6FkgSQS77V5sxvMuya3mn057dNp2B",
    category: "core",
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    path: "/dashboard",
    category: "core",
  },
  {
    id: "spectrometer",
    label: "Spectrometer",
    icon: Microscope,
    path: "/spectrometer",
    category: "core",
  },
  {
    id: "grades",
    label: "Grade Specs",
    icon: FileCheck,
    path: "/grades",
    category: "core",
  },
  {
    id: "raw-material-stock",
    label: "Raw Material Stock",
    icon: Boxes,
    path: "/raw-material-stock",
    category: "premelt",
  },
  {
    id: "yard-inspection",
    label: "Yard Inspection (XRF/LIBS)",
    icon: ScanLine,
    path: "/yard-inspection",
    category: "premelt",
  },
  {
    id: "premelt-gate",
    label: "Pre-Melt Gate",
    icon: ShieldCheck,
    path: "/premelt-gate",
    category: "premelt",
  },
  {
    id: "supplier-scorecard",
    label: "Supplier Scorecard",
    icon: Trophy,
    path: "/supplier-scorecard",
    category: "premelt",
  },
  {
    id: "energy",
    label: "Energy per Heat",
    icon: Zap,
    path: "/energy",
    category: "premelt",
  },
  {
    id: "inventory-forecast",
    label: "Inventory Forecast",
    icon: PackageSearch,
    path: "/inventory-forecast",
    category: "premelt",
  },
  {
    id: "sales",
    label: "Sales & Dispatch",
    icon: Receipt,
    path: "/sales",
    category: "premelt",
  },
  {
    id: "anomaly-detection",
    label: "Composition Deviation Analysis",
    icon: AlertTriangle,
    path: "/anomaly",
    category: "ai",
  },
  {
    id: "recommendation",
    label: "Melt Correction Planner",
    icon: Lightbulb,
    path: "/recommendation",
    category: "ai",
  },
  {
    id: "rl-optimizer",
    label: "Adaptive Strategy Optimizer",
    icon: Repeat,
    path: "/rl-optimizer",
    category: "ai",
  },
  {
    id: "agent",
    label: "AI Agent Analysis",
    icon: Bot,
    path: "/agent",
    category: "ai",
  },
  {
    id: "full-analysis",
    label: "Full Analysis",
    icon: Workflow,
    path: "/full-analysis",
    category: "ai",
  },
  {
    id: "mechanical-properties",
    label: "Mechanical Properties",
    icon: Gauge,
    path: "/mechanical-properties",
    category: "ai",
  },
  {
    id: "synthetic-data",
    label: "Synthetic Data",
    icon: Cpu,
    path: "/synthetic",
    category: "data",
  },
  {
    id: "training-data",
    label: "Training Data",
    icon: Database,
    path: "/training-data",
    category: "data",
  },
  {
    id: "semantic-search",
    label: "Semantic Search",
    icon: Sparkles,
    path: "/semantic-search",
    category: "data",
  },
  {
    id: "cost-analysis",
    label: "Cost Analysis",
    icon: IndianRupee,
    path: "/cost-analysis",
    category: "data",
  },
];

const Sidebar = ({ setRunTour }) => {
  const [isOpen, setIsOpen] = useState(false);
  const sidebarRef = useRef(null);
  const navigate = useNavigate();

  const [systemStatus, setSystemStatus] = useState({
    online: true,
    label: import.meta.env.VITE_MOCK_MODE === 'true' ? 'Mock Mode Online' : 'All Systems Online',
    subLabel: import.meta.env.VITE_MOCK_MODE === 'true' ? 'Deterministic In-Memory Engine' : 'OPC Connected • AI Ready'
  });

  useEffect(() => {
    let active = true;
    const checkSystemHealth = async () => {
      if (import.meta.env.VITE_MOCK_MODE === 'true') {
        if (active) {
          setSystemStatus({
            online: true,
            label: 'Mock Mode Online',
            subLabel: 'Deterministic In-Memory Engine'
          });
        }
        return;
      }
      try {
        const res = await fetch('/health', { method: 'GET' });
        if (active) {
          if (res.ok) {
            setSystemStatus({
              online: true,
              label: 'All Systems Online',
              subLabel: 'OPC Connected • Core Active'
            });
          } else {
            setSystemStatus({
              online: false,
              label: 'Services Degraded',
              subLabel: `HTTP Status ${res.status}`
            });
          }
        }
      } catch (_) {
        if (active) {
          setSystemStatus({
            online: false,
            label: 'System Offline',
            subLabel: 'Backend Unreachable'
          });
        }
      }
    };
    checkSystemHealth();
    const timer = setInterval(checkSystemHealth, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const toggleSidebar = () => setIsOpen(!isOpen);
  const closeSidebar = () => setIsOpen(false);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (sidebarRef.current && !sidebarRef.current.contains(event.target)) {
        closeSidebar();
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const { isUnlocked, flow } = useMeltFlow();
  // Sidebar grouped by production stage (General first).
  const byId = Object.fromEntries(sidebarItems.map((item) => [item.id, item]));
  const pick = (ids) => ids.map((id) => byId[id]).filter(Boolean);
  const STAGES = [
    { title: "Pre-Production", ids: ["supplier-scorecard", "inventory-forecast", "raw-material-stock", "yard-inspection", "premelt-gate", "energy"] },
    { title: "AI Analysis", ids: ["anomaly-detection", "recommendation", "rl-optimizer", "full-analysis", "agent"] },
    { title: "Post-Production", ids: ["mechanical-properties"] },
    { title: "Sales", ids: ["sales"] },
    { title: "Training Data", ids: ["synthetic-data", "training-data", "semantic-search", "cost-analysis"] },
  ];
  const stagedIds = new Set(STAGES.flatMap((st) => st.ids));
  const GENERAL_IDS = ["onboard-tour", "technical-docs", "dashboard", "spectrometer", "grades"];
  // Anything not placed in a stage stays visible under General.
  const coreItems = [...pick(GENERAL_IDS), ...sidebarItems.filter((item) => !GENERAL_IDS.includes(item.id) && !stagedIds.has(item.id))];
  const stageSections = STAGES.map((st) => ({ ...st, items: pick(st.ids) })).filter((st) => st.items.length);

  return (
    <>
      {/* Mobile Toggle Button */}
      <button
        onClick={toggleSidebar}
        className="fixed top-4 left-4 z-50 p-2 sm:hidden text-gray-500 bg-white rounded-lg shadow-lg"
      >
        <svg className="h-6" fill="currentColor" viewBox="0 0 20 20">
          <path
            clipRule="evenodd"
            fillRule="evenodd"
            d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z"
          />
        </svg>
      </button>

      <aside
        ref={sidebarRef}
        data-tour="sidebar"
        className={`fixed top-0 left-0 z-40 w-72 h-screen transition-transform bg-white shadow-xl border-r border-metal-200 transform ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } sm:translate-x-0`}
      >
        <div className="flex flex-col h-full">
          {/* Company Header */}
          <div className="bg-gradient-to-b from-emerald-50 to-green-50 px-4 py-5 border-b border-metal-200">
            <div className="flex items-center gap-3 ">
              <img
                src={logo}
                alt="MetalliSense Logo"
                className="h-12 w-auto object-cover"
              />
            </div>
          </div>

          {/* Menu Items with custom scrollbar */}
          <div className="flex-1 px-4 py-3 overflow-y-auto custom-scrollbar">
            <div className="space-y-8">
              {/* General */}
              <div className="pb-1">
                <div className="text-xs font-bold text-metal-500 uppercase tracking-wider mb-2 px-2">
                  General
                </div>

                {coreItems.map((item) => {
                  if (item.isTour) {
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setRunTour(true);
                          closeSidebar();
                        }}
                        className="w-full text-left flex items-center gap-3 p-2.5 rounded-lg text-sm font-medium transition-all duration-200 text-metal-700 hover:bg-emerald-50 hover:text-emerald-700"
                      >
                        <item.icon size={18} className="text-metal-500" />
                        <span className="text-xs">{item.label}</span>
                      </button>
                    );
                  }

                  if (item.isExternalLink) {
                    return (
                      <a
                        key={item.id}
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => { closeSidebar(); if (import.meta.env.VITE_MOCK_MODE === 'true') { e.preventDefault(); const url = URL.createObjectURL(new Blob(['MetalliSense browser demo: human-approved decision support. Receive lots, screen scrap, approve DRI QA, plan a charge, review GO/WARN/HOLD, approve melting, compare corrections and strategies, review mechanical estimates, approve tap and invoice. State and alerts remain in your browser. Use Reset demo data to reseed. Estimates are demonstrations, not physical test certificates.'], {type:'text/plain'})); const a=document.createElement('a'); a.href=url; a.download='MetalliSense-demo-guide.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } }}
                        className="w-full text-left flex items-center gap-3 p-2.5 rounded-lg text-sm font-medium transition-all duration-200 text-metal-700 hover:bg-emerald-50 hover:text-emerald-700"
                      >
                        <item.icon size={18} className="text-metal-500" />
                        <span className="text-xs">{item.label}</span>
                      </a>
                    );
                  }

                  return (
                    <NavLink
                      key={item.id}
                      to={item.path}
                      onClick={closeSidebar}
                      className={({ isActive }) =>
                        `w-full text-left flex items-center gap-3 p-2.5 rounded-lg text-sm font-medium transition-all duration-200  ${
                          isActive
                            ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25"
                            : "text-metal-700 hover:bg-emerald-50 hover:text-emerald-700"
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon
                            size={18}
                            className={
                              isActive ? "text-white" : "text-metal-500"
                            }
                          />
                          <span className="text-xs">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>

              {stageSections.map((section) => (
                <div key={section.title} className="pb-1">
                  <div className="text-xs font-bold text-metal-500 uppercase tracking-wider mb-2 px-2">
                    {section.title}
                  </div>
                  {section.items.map((item) => (
                    <NavLink
                      key={item.id}
                      to={item.path}
                      onClick={closeSidebar}
                      className={({ isActive }) =>
                        `w-full text-left flex items-center gap-3 p-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                          isActive
                            ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25"
                            : "text-metal-700 hover:bg-emerald-50 hover:text-emerald-700"
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon size={18} className={isActive ? "text-white" : "text-metal-500"} />
                          <span className="text-xs">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* System Status */}
          <div className="px-4 py-4 border-t border-metal-200">
            <div className={`border rounded-lg px-3 py-2 mb-4 ${
              systemStatus.online
                ? 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200'
                : 'bg-gradient-to-r from-rose-50 to-red-50 border-rose-200'
            }`}>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  systemStatus.online ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                }`}></div>
                <span className={`text-xs font-semibold ${
                  systemStatus.online ? 'text-emerald-700' : 'text-rose-700'
                }`}>
                  {systemStatus.label}
                </span>
              </div>
              <div className="text-xs text-metal-600 mt-1">
                {systemStatus.subLabel}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Custom Scrollbar Styles */}
      <style>
        {`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f1f5f8;
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #10b981;
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #059669;
        }
        `}
      </style>
    </>
  );
};

export default Sidebar;
