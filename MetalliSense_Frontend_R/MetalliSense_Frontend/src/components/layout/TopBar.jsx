import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useNavigate, Link } from "react-router-dom";
import { LogOut, User, ChevronDown, LogIn, Shield } from "lucide-react";
import OPCStatusIndicator from "./OPCStatusIndicator";

const TopBar = ({ title, actions }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = async () => {
    try {
      await logout();
      navigate("/login");
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const primaryRole = user?.roles?.[0] || "OPERATOR";

  return (
    <div className="bg-white/80 backdrop-blur-sm border-b border-metal-200 pl-14 sm:pl-16 pr-2 sm:px-6 py-2 sm:py-4 shadow-sm min-w-0">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-1.5 h-8 sm:h-10 bg-gradient-to-b from-emerald-500 to-emerald-600 rounded-full shadow-md flex-shrink-0" />
          <h1 className="text-sm sm:text-2xl font-bold text-metal-900 truncate max-w-[120px] sm:max-w-[200px] lg:max-w-none">{title}</h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
          {actions}
          <div className="hidden lg:flex"><OPCStatusIndicator /></div>

          {/* User Menu or Sign In */}
          {user ? (
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-1 sm:gap-2 px-1.5 sm:px-3 py-1 sm:py-2 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200"
              >
                <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-emerald-600 to-teal-700 flex items-center justify-center text-white font-semibold text-xs sm:text-sm shadow">
                  {user.displayName
                    ? user.displayName.charAt(0).toUpperCase()
                    : user.username?.charAt(0).toUpperCase()}
                </div>
                <div className="text-left hidden md:block">
                  <div className="text-sm font-semibold text-gray-900 leading-tight">
                    {user.displayName || user.username}
                  </div>
                  <div className="text-xs font-medium text-emerald-700 flex items-center gap-1">
                    <Shield className="w-3 h-3" />
                    <span>{user.roles ? user.roles.join(', ') : primaryRole}</span>
                  </div>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-gray-500 transition-transform ${
                    showUserMenu ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* Dropdown Menu */}
              {showUserMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowUserMenu(false)}
                  />
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                    <div className="px-4 py-3 border-b border-gray-100">
                      <p className="text-sm font-semibold text-gray-900">
                        {user.displayName || user.username}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {user.email || user.username}
                      </p>
                      <span className="inline-block mt-1 px-2 py-0.5 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded font-medium">
                        {primaryRole}
                      </span>
                    </div>

                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link
              to="/login"
              className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors shadow-sm"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default TopBar;
