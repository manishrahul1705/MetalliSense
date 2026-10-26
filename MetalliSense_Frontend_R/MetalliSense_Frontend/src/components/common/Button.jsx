import React from "react";
import clsx from "clsx";
import { CrucibleIcon } from "./FurnaceLoader";

const Button = ({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  className = "",
  ...props
}) => {
  const baseStyles =
    "font-semibold rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center";

  const variants = {
    primary:
      "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:from-emerald-600 hover:to-emerald-700 hover:shadow-lg focus:ring-emerald-500 shadow-md",
    secondary: "bg-gradient-dark text-white hover:shadow-lg focus:ring-metal-600",
    danger: "bg-gradient-to-r from-red-600 to-red-700 text-white hover:shadow-lg focus:ring-red-500",
    success: "bg-gradient-to-r from-emerald-700 to-teal-800 text-white hover:shadow-metal-lg focus:ring-emerald-700",
    outline:
      "border-2 border-primary-600 text-primary-600 hover:bg-primary-50 focus:ring-primary-500 bg-white",
    ghost: "text-metal-700 hover:bg-metal-100 focus:ring-metal-500",
  };

  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-5 py-2.5 text-base",
    lg: "px-8 py-3.5 text-lg",
  };

  return (
    <button
      className={clsx(baseStyles, variants[variant], sizes[size], className)}
      disabled={loading || disabled}
      {...props}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <CrucibleIcon size={18} className="text-current" />
          {children}
        </span>      ) : (
        children
      )}
    </button>
  );
};

export default Button;
