// server/mail/threadKey.ts  (spec §3.1)
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
  return t || null;
}
export function normalizeSubject(s: string): string {
  let t = (s || '').trim();
  const re = /^(re|fw|fwd|aw|wg)\s*:\s*/i;
  while (re.test(t)) t = t.replace(re, '').trim();
  return t.replace(/\s+/g, ' ').toLowerCase();
}
export function deriveThreadKey(
  lookup: (messageIdHeader: string) => string | null,
  env: { messageIdHeader: string | null; inReplyTo: string | null; references: string[]; fallbackSeed: string },
): { threadKey: string; synthetic: boolean } {
  const refs = env.references.map(normalizeMessageId).filter((x): x is string => !!x);
  const irt = normalizeMessageId(env.inReplyTo);
  const own = normalizeMessageId(env.messageIdHeader);
  const candidates = [...refs, ...(irt ? [irt] : []), ...(own ? [own] : [])];
  for (const c of candidates) { const k = lookup(c); if (k) return { threadKey: k, synthetic: false }; }
  if (refs.length) return { threadKey: refs[0], synthetic: false };
  if (irt) return { threadKey: irt, synthetic: false };
  if (own) return { threadKey: own, synthetic: false };
  return { threadKey: 'synthetic:' + crypto.createHash('sha1').update(env.fallbackSeed).digest('hex'), synthetic: true };
}
// A late-arriving root bridges two keys: fold `fromKey` into `toKey`. The
// mail_threads rollup for fromKey is dropped — the engine rebuilds toKey's.
export function mergeThreadKeys(db: Database.Database, accountId: string, fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  db.transaction(() => {
    db.prepare('UPDATE mail_messages SET threadKey = ? WHERE accountId = ? AND threadKey = ?').run(toKey, accountId, fromKey);
    db.prepare('DELETE FROM mail_threads WHERE accountId = ? AND threadKey = ?').run(accountId, fromKey);
    db.prepare('UPDATE OR IGNORE mail_thread_links SET threadKey = ? WHERE threadKey = ?').run(toKey, fromKey);
    db.prepare('DELETE FROM mail_thread_links WHERE threadKey = ?').run(fromKey); // leftovers that collided on the unique index
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(toKey, new Date().toISOString());
    db.prepare(`UPDATE mail_thread_reply_state SET
        lastInboundDate = MAX(COALESCE(lastInboundDate,''), COALESCE((SELECT lastInboundDate FROM mail_thread_reply_state WHERE threadKey = ?),'')),
        lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), COALESCE((SELECT lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?),''))
      WHERE threadKey = ?`).run(fromKey, fromKey, toKey);
    db.prepare('DELETE FROM mail_thread_reply_state WHERE threadKey = ?').run(fromKey);
  })();
}
