import React, { useEffect } from "react";
import { X } from "lucide-react";
import clsx from "clsx";

const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
  showClose = true,
}) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const sizes = {
    sm: "max-w-md",
    md: "max-w-2xl",
    lg: "max-w-4xl",
    xl: "max-w-6xl",
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-metal-900/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className={clsx(
            "relative bg-white rounded-2xl shadow-metal-xl border border-metal-200 w-full transform transition-all",
            sizes[size]
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-metal-200 bg-gradient-to-r from-metal-50 to-transparent">
              <div className="flex items-center gap-2">
                <div className="w-1 h-6 bg-gradient-metal rounded-full" />
                <h3 className="text-lg font-bold text-metal-900">{title}</h3>
              </div>
              {showClose && (
                <button
                  onClick={onClose}
                  className="text-metal-400 hover:text-metal-600 hover:bg-metal-100 p-2 rounded-lg transition-all"
                >
                  <X size={20} />
                </button>
              )}
            </div>
          )}

          {/* Content */}
          <div className="px-6 py-4">{children}</div>
        </div>
      </div>
    </div>
  );
};

export default Modal;
