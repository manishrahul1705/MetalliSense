import React, { useState } from "react";
import { Outlet } from "react-router-dom";
import Joyride from "react-joyride";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import { useLocation } from "react-router-dom";

const pageTitles = {
  "/": "Dashboard",
  "/dashboard": "Dashboard",
  "/anomaly": "Anomaly Detection",
  "/recommendation": "Alloy Recommendation",
  "/agent": "AI Agent Analysis",
  "/grades": "Grade Specifications",
  "/synthetic": "Synthetic Data Generator",
  "/spectrometer": "Spectrometer Readings",
  "/training-data": "Training Data Management",
};

const MainLayout = () => {
  const location = useLocation();
  const title = pageTitles[location.pathname] || "MetalliSense";
  const [runTour, setRunTour] = useState(false);

  const tourSteps = [
    {
      target: "body",
      content: (
        <div>
          <h2 className="text-2xl font-bold mb-3">
            Welcome to MetalliSense! 
          </h2>
          <p className="text-metal-600">
            MetalliSense is an industrial-grade metal analysis and quality
            control system that integrates with OPC UA servers for real-time
            spectrometer readings.
          </p>
        </div>
      ),
      placement: "center",
    },
    {
      target: '[data-tour="sidebar"]',
      content:
        "Use this sidebar to navigate between different sections of the application. Operations are organized into Core, AI & Analytics, and Data Management categories.",
    },
    {
      target: '[data-tour="opc-status"]',
      content:
        "Monitor your OPC server connection status here. The indicator updates in real-time and shows connection details.",
    },
    {
      target: '[data-tour="dashboard-stats"]',
      content:
        "View key metrics and statistics about your metal analysis operations, including readings, grades, and anomalies detected.",
    },
  ];

  const handleJoyrideCallback = (data) => {
    const { status } = data;
    if (status === "finished" || status === "skipped") {
      setRunTour(false);
      localStorage.setItem("onboardTourCompleted", "true");
    }
  };

  return (
    <div className="flex h-screen bg-gradient-to-br from-metal-50 via-metal-100 to-primary-50">
      <Joyride
        steps={tourSteps}
        run={runTour}
        continuous
        showProgress
        showSkipButton
        callback={handleJoyrideCallback}
        styles={{
          options: {
            primaryColor: "#15c26b",
            zIndex: 10000,
          },
        }}
      />
      <Sidebar setRunTour={setRunTour} />
      <div className="flex-1 ml-72 flex flex-col overflow-hidden">
        <TopBar title={title} />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
