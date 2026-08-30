// src/pages/project/proposal/useProposalEmailDefaults.ts
// Who a proposal goes to, before the estimator types anything: the estimating
// recipient resolved from the project/customer role emails, the user's
// always-CC list, and the from-addresses the letterhead can advertise.
import { useEffect, useState } from 'react';
import { getAlwaysCc, getCustomer, getProject, getSettings, getMailAccounts, pickSendableAccount } from '../../../utils/store';
import { resolveRecipient } from '../../../utils/recipients';
import type { Customer } from '../../../types';

export interface ProposalEmailDefaults {
  defaultTo: string;
  defaultCc: string;
  defaultBcc: string;
  /** The company address the letterhead uses unless the sender picks another. */
  companyEmail: string;
  headerEmailOptions: { label: string; value: string }[];
}

const EMPTY: ProposalEmailDefaults = {
  defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [],
};

const mergeCsv = (...lists: string[]) =>
  Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');

export function useProposalEmailDefaults(projectId?: string): ProposalEmailDefaults {
  const [defaults, setDefaults] = useState<ProposalEmailDefaults>(EMPTY);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [settings, mailAccounts, alwaysCc, proj] = await Promise.all([
          getSettings(),
          getMailAccounts().catch(() => []),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (proj?.customerId) customer = await getCustomer(proj.customerId).catch(() => undefined);
        if (cancelled) return;
        const resolved = resolveRecipient('proposal', proj?.contactEmails, customer?.emails);
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = pickSendableAccount(mailAccounts)?.emailAddress ?? '';
        setDefaults({
          defaultTo: resolved.to,
          defaultCc: mergeCsv(resolved.cc, alwaysCc),
          defaultBcc: resolved.bcc,
          companyEmail,
          headerEmailOptions: [
            companyEmail ? { label: 'Company default', value: companyEmail } : null,
            fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
          ].filter((o): o is { label: string; value: string } => o !== null),
        });
      } catch { /* non-fatal — the composer just opens with empty fields */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  return defaults;
}
