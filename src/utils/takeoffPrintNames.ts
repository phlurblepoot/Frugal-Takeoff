// src/utils/takeoffPrintNames.ts
//
// Naming + navigation helpers for the Takeoffs tab's Print/Excel exports,
// which now save as `takeoff-print` / `takeoff-export` documents (spec
// 2026-08-28-proposal-rework Task 9) instead of appending to the removed
// project.printouts[] list. Shared between ProjectView.tsx (which saves and
// navigates) and ProjectTakeoffsTab.tsx (which renders the "Takeoff prints"
// link) so the name/URL format stays in exactly one place.
export const takeoffPrintName = (projectName: string, kind: 'pdf' | 'excel', when: Date = new Date()) =>
  `${kind === 'excel' ? 'Takeoff Export' : 'Takeoff Print'} – ${projectName} – ${when.toISOString().slice(0, 10)}`;

export const takeoffPrintsUrl = (projectId: string) =>
  `/documents?projectIds=${projectId}&kinds=takeoff-print,takeoff-export`;
