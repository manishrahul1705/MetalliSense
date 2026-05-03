import React from "react";
import clsx from "clsx";

const Slider = ({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  showValue = true,
  className = "",
  containerClassName = "",
}) => {
  return (
    <div className={clsx("mb-4 ", containerClassName)}>
      <div className="flex justify-between items-center mb-2">
        {label && (
          <label className="block text-sm font-medium text-dark-700">
            {label}
          </label>
        )}
        {showValue && (
          <span className="text-sm font-mono text-dark-600">
            {value}
            {max <= 100 ? "%" : ""}
          </span>
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={clsx(
          "w-full h-2 bg-dark-200 rounded-lg appearance-none cursor-pointer slider",
          className
        )}
        style={{
          background: `linear-gradient(to right, #16a34a 0%, #16a34a ${
            ((value - min) / (max - min)) * 100
          }%, #e2e8f0 ${((value - min) / (max - min)) * 100}%, #e2e8f0 100%)`,
        }}
      />
      <div className="flex justify-between text-xs text-dark-500 mt-1">
        <span>
          {min}
          {max <= 100 ? "%" : ""}
        </span>
        <span>
          {max}
          {max <= 100 ? "%" : ""}
        </span>
      </div>
    </div>
  );
};

export default Slider;
