// src/pages/project/EmailTab.tsx
//
// Email tab content extracted verbatim from ProjectView (Phase 5e Task 4).
// Behavior-preserving: shows the source email header, an optional proposal-sent
// badge, and the email thread with per-message expand/collapse (HTML in a
// sandboxed iframe, or plain text). The expand/collapse state lives here because
// it's used only by this tab.
import { useState } from 'react';
import { Mail, Send, ChevronUp, ChevronDown } from 'lucide-react';
import { Project } from '../../types';

interface EmailTabProps {
  project: Project;
  /** Omitted for non-admins — proposals are an admin-only section. */
  onOpenProposal?: () => void;
}

export function EmailTab({ project, onOpenProposal }: EmailTabProps) {
  const [expandedThreadKeys, setExpandedThreadKeys] = useState<Set<number>>(new Set());

  if (!project.email) return null;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-accent-50 dark:bg-accent-900/30 shrink-0">
            <Mail size={18} className="text-accent-600 dark:text-accent-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-slate-900 dark:text-white leading-tight">{project.email.subject}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              <span className="font-medium text-slate-700 dark:text-slate-300">{project.email.fromName || project.email.from}</span>
              {project.email.fromName && <span className="text-slate-400"> &lt;{project.email.from}&gt;</span>}
              <span className="ml-2">{new Date(project.email.receivedAt).toLocaleString()}</span>
            </p>
          </div>
          {onOpenProposal && (
            <button
              onClick={onOpenProposal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-600 text-white text-xs font-medium hover:bg-accent-700 transition-all shrink-0"
            >
              <Send size={13} /> Send Proposal
            </button>
          )}
        </div>

        {/* Proposal-sent badge removed (proposalSentAt lived on Project;
            proposal send status now lives on the Proposal itself — see the
            Proposal section, sentAt/sentTo on ProposalSummary). */}

        {(() => {
          const thread = project.emails && project.emails.length > 0
            ? [...project.emails].reverse() // newest first
            : project.email ? [project.email] : [];
          return (
            <div className="space-y-2">
              {thread.map((em, idx) => {
                const isLatest = idx === 0;
                const isOpen = isLatest || expandedThreadKeys.has(idx);
                const toggle = () => setExpandedThreadKeys(s => {
                  const n = new Set(s); isOpen ? n.delete(idx) : n.add(idx); return n;
                });
                return (
                  <div key={idx} className="rounded-xl border border-slate-200 dark:border-slate-600 overflow-hidden">
                    <button onClick={toggle} className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors ${isLatest ? 'bg-accent-50 dark:bg-accent-900/20' : 'bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700/60'}`}>
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                        {em.fromName || em.from}
                        {em.fromName && <span className="ml-1 text-slate-400 font-normal text-xs">&lt;{em.from}&gt;</span>}
                      </span>
                      <span className="flex items-center gap-2 shrink-0 ml-3">
                        <span className="text-xs text-slate-400">{new Date(em.receivedAt).toLocaleDateString()}</span>
                        {isOpen ? <ChevronUp size={13} className="text-slate-400" /> : <ChevronDown size={13} className="text-slate-400" />}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-slate-100 dark:border-slate-700">
                        {em.htmlBody ? (
                          <iframe
                            srcDoc={em.htmlBody}
                            sandbox="allow-same-origin allow-popups"
                            title="Email content"
                            className="w-full bg-white"
                            style={{ minHeight: 120 }}
                            onLoad={e => {
                              const frame = e.currentTarget;
                              try {
                                const doc = frame.contentDocument;
                                if (!doc) return;
                                const h = doc.documentElement?.scrollHeight;
                                if (h && h > 0) frame.style.height = h + 16 + 'px';
                                doc.querySelectorAll('a[href]').forEach(a => {
                                  (a as HTMLAnchorElement).target = '_blank';
                                  (a as HTMLAnchorElement).rel = 'noopener noreferrer';
                                });
                              } catch {}
                            }}
                          />
                        ) : (
                          <p className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{em.body}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
