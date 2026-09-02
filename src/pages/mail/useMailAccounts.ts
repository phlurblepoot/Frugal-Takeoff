// src/pages/mail/useMailAccounts.ts — the user's connected mailboxes, kept
// live so connecting/removing an account in Settings updates the mail page.
import { useCallback, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import type { MailAccount } from './types';

export interface MailAccountsState {
  accounts: MailAccount[];
  loading: boolean;
  reload: () => void;
}

export function useMailAccounts(): MailAccountsState {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const rows = await mailApi.accounts();
      setAccounts(Array.isArray(rows) ? rows : []);
    } catch {
      // A failure here is indistinguishable to the user from "no mailboxes
      // connected", and that state already has a clear CTA — so fall back to
      // it rather than showing an error over an empty page.
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useLiveQuery(load, { types: ['mailAccount'] });

  return { accounts, loading, reload: load };
}
