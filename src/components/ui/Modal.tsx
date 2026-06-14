// src/components/ui/Modal.tsx
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[95vw]' } as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open, onClose, title, footer, width = 'md', children,
}) => {
  const labelId = React.useId();

  // Note: the listener re-registers if `onClose` changes identity each render
  // (inline arrows). Harmless, but stable handlers via useCallback are nicer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          data-testid="modal-overlay"
          className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          {/* TODO Phase 5 (a11y pass): focus trap + initial focus + restore on close */}
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title !== undefined ? labelId : undefined}
            className={`flex max-h-[85vh] w-full ${WIDTHS[width]} flex-col rounded-xl border border-edge bg-raised shadow-xl`}
            onClick={(e) => e.stopPropagation()}
          >
            {title !== undefined && (
              <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-4">
                <h2 id={labelId} className="text-base font-semibold text-ink">{title}</h2>
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex shrink-0 justify-end gap-2 border-t border-edge px-5 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
