import React from "react";
import clsx from "clsx";

const Table = ({
  columns,
  data,
  loading = false,
  emptyMessage = "No data available",
}) => {
  if (loading) {
    return (
      <div className="w-full overflow-x-auto rounded-xl border border-metal-200">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-gradient-to-r from-metal-50 to-primary-50 border-b-2 border-metal-200">
              {columns.map((column, index) => (
                <th
                  key={index}
                  className="px-6 py-4 text-left text-xs font-bold text-metal-700 uppercase tracking-wider"
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...Array(5)].map((_, index) => (
              <tr key={index} className="animate-pulse border-b border-metal-100">
                {columns.map((_, colIndex) => (
                  <td key={colIndex} className="px-6 py-4">
                    <div className="h-4 bg-metal-200 rounded w-3/4"></div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-12 text-metal-500 bg-metal-50 rounded-xl border border-metal-200">
        <p className="font-medium">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto rounded-xl border border-metal-200 shadow-metal">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gradient-to-r from-metal-50 to-primary-50 border-b-2 border-metal-200">
            {columns.map((column, index) => (
              <th
                key={index}
                className={clsx(
                  "px-6 py-4 text-left text-xs font-bold text-metal-700 uppercase tracking-wider",
                  column.headerClassName
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-metal-100">
          {data.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-primary-50/50 transition-all">
              {columns.map((column, colIndex) => (
                <td
                  key={colIndex}
                  className={clsx(
                    "px-6 py-4 text-sm text-metal-900 font-medium",
                    column.cellClassName
                  )}
                >
                  {column.render ? column.render(row) : row[column.accessor]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Table;
