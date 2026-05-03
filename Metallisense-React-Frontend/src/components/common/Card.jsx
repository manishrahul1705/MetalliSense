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
            "px-6 py-4 border-b border-metal-200 flex justify-between items-center bg-gradient-to-r from-metal-50 to-transparent",
            headerClassName
          )}
        >
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 bg-gradient-metal rounded-full" />
            <h3 className="text-lg font-bold text-metal-900">{title}</h3>
          </div>
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
};

export default Card;
