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
} from "lucide-react";
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
    id: "anomaly-detection",
    label: "Anomaly Detection",
    icon: AlertTriangle,
    path: "/anomaly",
    category: "ai",
  },
  {
    id: "recommendation",
    label: "Alloy Recommendation",
    icon: Lightbulb,
    path: "/recommendation",
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
];

const Sidebar = ({ setRunTour }) => {
  const [isOpen, setIsOpen] = useState(false);
  const sidebarRef = useRef(null);
  const navigate = useNavigate();

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

  const coreItems = sidebarItems.filter((item) => item.category === "core");
  const aiItems = sidebarItems.filter((item) => item.category === "ai");
  const dataItems = sidebarItems.filter((item) => item.category === "data");

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
              {/* Core Operations */}
              <div className="pb-1">
                <div className="text-xs font-bold text-metal-500 uppercase tracking-wider mb-2 px-2">
                  Core Operations
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
                        onClick={closeSidebar}
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

              {/* AI & Analytics */}
              <div className="pb-1">
                <div className="text-xs font-bold text-metal-500 uppercase tracking-wider mb-2 px-2">
                  AI & Analytics
                </div>

                {aiItems.map((item) => (
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
                        <item.icon
                          size={18}
                          className={isActive ? "text-white" : "text-metal-500"}
                        />
                        <span className="text-xs">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>

              {/* Data Management */}
              <div>
                <div className="text-xs font-bold text-metal-500 uppercase tracking-wider mb-2 px-2">
                  Data Management
                </div>

                {dataItems.map((item) => (
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
                        <item.icon
                          size={18}
                          className={isActive ? "text-white" : "text-metal-500"}
                        />
                        <span className="text-xs">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>

          {/* System Status */}
          <div className="px-4 py-4 border-t border-metal-200">
            <div className="bg-gradient-to-r from-emerald-50 to-green-50 border border-emerald-200 rounded-lg px-3 py-2 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                <span className="text-xs text-emerald-700 font-semibold">
                  All Systems Online
                </span>
              </div>
              <div className="text-xs text-metal-600 mt-1">
                OPC Connected • AI Ready
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
