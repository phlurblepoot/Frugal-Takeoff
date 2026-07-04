import type { SheetRead, SheetMatch, ExistingSheetRef } from './types';

/** Pull the first balanced JSON object out of a string, tolerant of surrounding prose. */
function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

export function buildReadPrompt(embeddedText?: string): string {
  const hint = embeddedText && embeddedText.trim()
    ? `\n\nFor reference, here is text extracted from the drawing's PDF layer (may be noisy or incomplete). Prefer it when it agrees with what you see:\n"""${embeddedText.trim().slice(0, 2000)}"""`
    : '';
  return (
    `You are reading a single sheet from a set of construction/architectural drawings. Extract:\n` +
    `- sheetNumber: the drawing identifier printed on the sheet (e.g. "A-201", "S1.1", "RC-A-106", "E001"), ` +
    `usually in the title block along the right or bottom edge. Ignore unrelated numbers (project/record numbers, room tags, detail callouts).\n` +
    `- sheetTitle: a concise title for what THIS sheet depicts. If the title block prints an explicit sheet title, use it verbatim. ` +
    `If it does NOT, look at the drawings and infer a short conventional title from the content — e.g. "Exterior Elevations", ` +
    `"Second Floor Plan", "Building Sections", "Wall Details", "Roof Plan", "Door Schedule". ` +
    `Do NOT use the heading of a legend, keynotes, general notes, or a notes table as the title.\n` +
    `- discipline: one of Architectural, Structural, Mechanical, Electrical, Plumbing, Civil, or similar.\n` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"sheetNumber": string, "sheetTitle": string, "discipline": string, "confidence": number between 0 and 1}. ` +
    `Use empty strings and a low confidence only when the sheet is genuinely unreadable.` +
    hint
  );
}

export function parseReadResponse(raw: string): SheetRead {
  const obj = extractJson(raw);
  if (!obj) return { sheetNumber: '', sheetTitle: '', confidence: 0 };
  const sheetNumber = String(obj.sheetNumber ?? '').trim().toUpperCase();
  const sheetTitle = String(obj.sheetTitle ?? '').trim();
  const discipline = obj.discipline ? String(obj.discipline).trim() : undefined;
  return { sheetNumber, sheetTitle, discipline, confidence: clamp01(obj.confidence) };
}

export function buildMatchPrompt(page: SheetRead, existing: ExistingSheetRef[]): string {
  const list = existing.map(e => `- id="${e.sheetId}" number="${e.number}" title="${e.title}"`).join('\n');
  return (
    `You are matching a new drawing sheet against an existing set to decide if it is a REVISION of one of them ` +
    `(the same logical sheet re-issued) or a brand new sheet. Sheet numbers or titles may have changed slightly between revisions.\n\n` +
    `New sheet: number="${page.sheetNumber}" title="${page.sheetTitle}"${page.discipline ? ` discipline="${page.discipline}"` : ''}\n\n` +
    `Existing sheets:\n${list || '(none)'}\n\n` +
    `Respond with ONLY a JSON object of the form ` +
    `{"matchSheetId": string, "confidence": number, "reason": string}, ` +
    `where matchSheetId is one of the ids above if this is a revision of that sheet, or the literal "new" if it is a new sheet.`
  );
}

export function parseMatchResponse(raw: string, validIds: string[]): SheetMatch {
  const obj = extractJson(raw);
  if (!obj) return { matchSheetId: null, confidence: 0, reason: undefined };
  const id = String(obj.matchSheetId ?? '').trim();
  const matchSheetId = validIds.includes(id) ? id : null;
  const reason = obj.reason ? String(obj.reason).trim().slice(0, 200) : undefined;
  return { matchSheetId, confidence: clamp01(obj.confidence), reason };
}
