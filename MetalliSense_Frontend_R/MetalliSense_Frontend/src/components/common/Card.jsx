import React from "react";
import clsx from "clsx";

const Card = ({
  title,
  children,
  actions,
  className = "",
  headerClassName = "",
}) => {
  return (
    <div
      className={clsx(
        "bg-white rounded-xl shadow-metal border border-metal-200 hover:shadow-metal-lg transition-all duration-200",
        className
      )}
    >
      {title && (
        <div
          className={clsx(
            "px-4 sm:px-6 py-3 sm:py-4 border-b border-metal-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 bg-gradient-to-r from-metal-50 to-transparent",
            headerClassName
          )}
        >
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 bg-gradient-metal rounded-full" />
            <h3 className="text-lg font-bold text-metal-900">{title}</h3>
          </div>
          {actions && <div className="flex flex-wrap gap-2 items-center">{actions}</div>}
        </div>
      )}
      <div className="p-3 sm:p-6">{children}</div>
    </div>
  );
};

export default Card;
