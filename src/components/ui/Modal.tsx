// src/components/ui/Modal.tsx
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[95vw]' } as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tabbable descendants in DOM order, minus the ones hidden from assistive tech.
// Deliberately cheap: no layout reads, so it stays correct under jsdom too.
const focusable = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    el => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  );

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
  const panelRef = React.useRef<HTMLDivElement | null>(null);

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

  // Focus management: move focus into the dialog when it opens, keep Tab inside
  // it while it is open, and hand focus back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    // The panel mounts with the animation, so focus on the next frame.
    const id = window.setTimeout(() => {
      const p = panelRef.current;
      if (!p || p.contains(document.activeElement)) return;
      (focusable(p)[0] ?? p).focus();
    }, 0);
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const p = panelRef.current;
      if (!p) return;
      const items = focusable(p);
      if (items.length === 0) {
        e.preventDefault();
        p.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!p.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onTab, true);
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [open]);

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
          <motion.div
            ref={panelRef}
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby={title !== undefined ? labelId : undefined}
            className={`flex max-h-[90dvh] w-full ${WIDTHS[width]} flex-col rounded-xl border border-edge bg-raised shadow-xl`}
            onClick={(e) => e.stopPropagation()}
          >
            {title !== undefined && (
              <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-4">
                <h2 id={labelId} className="text-base font-semibold text-ink">{title}</h2>
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-edge px-5 py-4 pb-safe">
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
