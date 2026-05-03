import React from "react";
import clsx from "clsx";

const Select = ({
  label,
  error,
  options = [],
  className = "",
  containerClassName = "",
  ...props
}) => {
  return (
    <div className={clsx("mb-4", containerClassName)}>
      {label && (
        <label className="block text-sm font-semibold text-metal-800 mb-2">
          {label}
        </label>
      )}
      <select
        className={clsx(
          "w-full px-4 py-2.5 border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-all bg-white font-medium text-metal-900",
          error ? "border-red-500 focus:ring-red-500" : "border-metal-200",
          className
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1.5 text-sm text-red-600 font-medium">{error}</p>}
    </div>
  );
};

export default Select;
