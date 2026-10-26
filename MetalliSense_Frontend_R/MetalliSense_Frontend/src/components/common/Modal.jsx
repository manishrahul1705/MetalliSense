import React, { useEffect, useRef } from "react";
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
  const modalRef = useRef(null);
  const prevActiveRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      prevActiveRef.current = document.activeElement;
      document.body.style.overflow = "hidden";

      // Focus first focusable element inside modal
      const timer = setTimeout(() => {
        if (modalRef.current) {
          const focusables = modalRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (focusables.length > 0) {
            focusables[0].focus();
          }
        }
      }, 50);

      const handleKeyDown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
          return;
        }

        if (e.key === "Tab" && modalRef.current) {
          const focusables = Array.from(
            modalRef.current.querySelectorAll(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          );
          if (focusables.length === 0) return;

          const first = focusables[0];
          const last = focusables[focusables.length - 1];

          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "unset";
        if (prevActiveRef.current && typeof prevActiveRef.current.focus === "function") {
          prevActiveRef.current.focus();
        }
      };
    } else {
      document.body.style.overflow = "unset";
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizes = {
    sm: "max-w-md",
    md: "max-w-2xl",
    lg: "max-w-4xl",
    xl: "max-w-6xl",
  };

  const titleId = title ? "modal-title-" + title.toLowerCase().replace(/[^a-z0-9]/g, "-") : undefined;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-metal-900/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={clsx(
            "relative bg-white rounded-2xl shadow-metal-xl border border-metal-200 w-full transform transition-all motion-reduce:transition-none",
            sizes[size]
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-metal-200 bg-gradient-to-r from-metal-50 to-transparent">
              <div className="flex items-center gap-2">
                <div className="w-1 h-6 bg-gradient-metal rounded-full" />
                <h3 id={titleId} className="text-lg font-bold text-metal-900">{title}</h3>
              </div>
              {showClose && (
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="text-metal-400 hover:text-metal-600 hover:bg-metal-100 p-2 rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-primary-500"
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
