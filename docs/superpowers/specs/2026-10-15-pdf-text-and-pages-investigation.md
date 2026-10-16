# PDF text without a box, and pages from other PDFs: investigation

Date: 2026-10-15 · Task T14 (items §1 and §2 of `.knowledge/requests-2026-10-15.md`) · Status: findings for the owner's decision (T15). Nothing has been built.

## The short version

**Text (§2).** The white box comes from **Comment → Text Comment**. That tool makes a PDF "FreeText" annotation, and ONLYOFFICE 9.4 always gives it a white fill and a 1 pt black border. The 9.4 interface has no control to remove either one. ONLYOFFICE 9.4 does have a box-free way to type, though: **switch to Edit PDF, then Insert → Text Box**. In the PDF editor that text box has no fill and no border. A hands-on check on our 9.4.0.1 server should come first; it costs nothing. If that check fails, the cheapest build is a small ONLYOFFICE plugin (1–1.5 days). It adds an "Add text" button that makes borderless, transparent text, plus a "Remove boxes" button. An in-app fill-in tool (3–4 days) only makes sense if forms must be filled **on phones**, because the editor is view-only there. ONLYOFFICE 10.0 (released 3 days ago) adds a "No Fill" setting for text comments, but only one box at a time. That upgrade can come later, as a planned upgrade.

**Pages (§1, inside the editor).** ONLYOFFICE 9.4 can add blank pages, delete, rotate and reorder pages. It can also **copy pages from one open PDF and paste them into another**. Neither 9.4 nor 10.0 can insert pages from a file that isn't open, and no plugin interface does it. Recommendation: put page picking (which pages, and where they go) into the app's own **Append pages** dialog (T12), on the server. That works everywhere, phones included. An "Insert pages" button inside the editor can come later, if the owner still wants it after trying copy and paste.

## How this was checked

- **ONLYOFFICE source code at the version we run.** The setup checklist records that our image `onlyoffice/documentserver:9.4.0.1` (docker-compose.yml l.53) matches the source tag `v9.4.0.97` (docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md, "Source check done (2026-09-26 …)"). I read `ONLYOFFICE/sdkjs` (the editing engine) and `ONLYOFFICE/web-apps` (the interface) at that tag. For comparison I also read `v10.0.0.99`; Docker Hub tag `10.0.0.1` was last updated 2026-10-12.
- **ONLYOFFICE help center:** PDF Editor guide pages Insert tab, Editing PDF, Comment tab, Adding text callouts.
- **ONLYOFFICE community forum:** "Add PDF pages from file" (staff replies 2026-02-27 and 2026-03-02) and "Missing Edit Text button … Community Edition" (2025-05).
- **This app's code:** `server/onlyoffice/editorConfig.ts`, `editorRoutes.ts`, `historyRoutes.ts`, `src/pages/DocumentEditor.tsx`, `src/utils/pdfAttachments.ts`, `src/utils/pdfOverlayTransform.ts`, and the PDF editor removed in 4.0.0 (`git show 330802e^:src/pages/PdfEditor.tsx`).
- **Not done:** nothing was clicked through on a live ONLYOFFICE 9.4. The source reading is strong evidence, but each "verify" item below needs a 15-minute hands-on check on `docs-test` (see "Hands-on check").

## §2 Text on flat forms: findings

### T1. The white box is the Text Comment annotation, and 9.4 hard-codes its look

- The PDF editor opens in **Annotate** mode, never in Edit PDF mode (web-apps `apps/pdfeditor/main/app/controller/Main.js` l.1344: `isPDFEdit = false; … always open in view mode`). In Annotate mode the obvious tool for typing is **Comment → Text Comment** (or its drop-down **Insert text callout**). Under the hood that is `api.AddFreeTextAnnot` (web-apps `controller/Toolbar.js` l.1264-1265).
- `CPDFDoc.AddFreeTextAnnot` (sdkjs `pdf/src/document.js` l.6838-6900) sets every new text comment to `SetFillColor([1,1,1])` (white), `SetBorderColor([0,0,0])` (black) and `SetBorderWidth(1)`. The subject is "Text box", with a 200×85 pt box in the middle of the view. This is the white box the owner sees.
- In 9.4 the only controls on a selected annotation are a stroke colour button (it changes the **border** colour) and opacity (web-apps `view/DocumentHolderExt.js` `createAnnotSelectBar` l.2222-2316; `controller/DocumentHolderExt.js` calls only `SetAnnotStrokeColor` and `SetAnnotOpacity`, l.2619 and l.2646). The engine does have `SetAnnotFillColor` and `SetAnnotStrokeWidth` (sdkjs `pdf/api.js` l.3200 and l.3314). Nothing in the 9.4 interface calls them, and `SetAnnotFillColor` takes only a colour, never "none". **A user can't remove the fill or the border in 9.4.** Opacity fades the text along with the box, so it doesn't help.

### T2. Edit PDF → Insert → Text Box has no fill and no border already

- When the PDF editor creates a text box shape (`textRect`), it gets `CNoFill` and no line. Word-style editors get the white fill and black 0.5 pt line (sdkjs `common/Drawings/TrackObjects/NewShapeTracks.js` l.730-760: `if ((drawingObjects && drawingObjects.cSld) || isPdf) { fill = CNoFill }`; the `ln` with the black line is only in the `else` branch). A click without a drag makes a box that grows with the text (`wrap = nTWTNone`, autofit, l.784-792).
- The Insert tab is visible **only in Edit PDF mode** (web-apps `controller/Toolbar.js` l.1704: `toolbar.setVisible('ins', this.mode.isPDFEdit)`). The user switches modes in the editor (Home tab mode switch: View / Annotate / Edit PDF). Our config allows it, because the user has `permissions.edit` on desktop (`server/onlyoffice/editorConfig.ts` l.65-72; `editorRoutes.ts` l.113-115).
- Edit PDF needs `canPDFEdit`, which depends on a license check (`Main.js` l.1343). The Community Edition passes it: a Community Edition user reports switching to Edit PDF and adding text boxes. Their only gap was the separate **Edit Text** button for changing existing text (forum, May 2025, unanswered). **Verify on our server.**
- Edit PDF content is saved into the page, not as an annotation, so every viewer and printer shows it. That is what a filled-in flat form wants. **Verify** by opening the saved version in Chrome's viewer and in Acrobat.
- Cost to the user: one mode switch per session, then Insert → Text Box and a click per field. Font and size come from the Home tab's text controls. Text boxes then move and resize like any shape.

### T3. ONLYOFFICE 10.0 adds "No Fill" and border settings for text comments, per box

- web-apps `v10.0.0.99` adds `apps/pdfeditor/main/app/view/AnnotationSettings.js`. It is a right-hand panel with a background colour menu that includes **No Fill** (`SetAnnotFillColor(undefined)`, l.559-560) and border colour (including transparent) and width (l.528, l.538-542). The 10.0 engine accepts "no colour" (sdkjs `v10.0.0.99` `pdf/api.js` l.3489-3500).
- The defaults are unchanged in 10.0: a new text comment is still white with a black border (sdkjs `v10.0.0.99` `pdf/src/document.js`, the same `SetFillColor([1,1,1])` / `SetBorderWidth(1)`). So 10.0 means two or three clicks on every box. That makes typing possible, but it is tedious on a form with 30 fields.
- 10.0.0.1 has been out three days. The pin policy (docker-compose.yml comment; docs/onlyoffice-setup.md "The version is pinned on purpose. To upgrade:") means reading the changelog and re-testing the app's editor features: save, version history, restore, mentions, thumbnails, share links and Make PDF. Upgrading is the owner's call. Treat it as its own task, not as the §2 fix.

### T4. A plugin can make borderless text in Annotate mode, but can't change the default

- The PDF document-building API that plugins use (`callCommand`) has `Api.CreateFreeTextAnnot(rect)`, `ApiPage.AddObject(annot)` (l.1612) and `ApiPage.GetAllAnnots()` (sdkjs `pdf/apiBuilder.js` l.592, l.1643). It also has `ApiBaseAnnotation.SetFillColor()`, where no argument means no fill (l.3974; FreeText is shape-based: `CAnnotationFreeText` extends `CGroupShape`, `pdf/src/annotations/freeText.js` l.56 and l.79; `annotations/base.js` l.886), and `SetBorderWidth` (l.4022).
- Plugin methods available in 9.4: `GetCurrentPage` (sdkjs `pdf/api_plugins.js` l.85), `AddToolbarMenuItem` and `AddContextMenuItem` (sdkjs `common/apiBase_plugins.js` l.2183 and l.2084).
- No plugin event fires when an annotation is added (sdkjs `pdf/plugin-events.js` declares none). A plugin therefore can't quietly fix every new Text Comment. It can only offer buttons:
  - **Add text**: creates a FreeText on the current page with no fill and border width 0, then the user drags it into place and types.
  - **Remove boxes**: strips the fill and border from every Text Comment on the page that still has the default white fill and black 1 pt border.
- This app can already load hidden plugins in the Community Edition, through `editorConfig.plugins.pluginsData` (checklist, 2026-09-26 source check). The app adds no framing headers that would stop the plugin page loading in the editor's frame: there's no `X-Frame-Options` or `frame-ancestors` in `server.ts` or `server/*.ts`.
- The result is still an annotation (FreeText). Other viewers show it and it prints, if its print flag is set. **Verify** that ONLYOFFICE sets the print flag on FreeText it creates, by printing from Chrome. Other people can move or delete it in any PDF tool, which for a filled form is mostly fine.

### T5. Real form fields only help PDFs that already have them

- A PDF with AcroForm fields already fills without boxes: `permissions.fillForms` is on when editing (`editorConfig.ts` l.69). A PDF that ONLYOFFICE made as a form opens in its form filler (web-apps `apps/api/documents/api.js` l.1119-1123, `document.isForm` left unset, so ONLYOFFICE sniffs the file).
- A **flat** form has no fields. To use fields, someone would add each one in Edit PDF → Forms, then fill it. That is more work than typing text, so it isn't a fix for §2.

### T6. Phones can't fill anything in ONLYOFFICE here

- The app opens every file on a phone in view mode, because the Community Edition doesn't edit in mobile browsers (`server/onlyoffice/editorRoutes.ts` l.113-115, decision 2026-09-25). If forms are filled in the field on a phone, no ONLYOFFICE option above helps. Only an in-app tool would.

## §2 Options

| | Option | What the user does | Effort | Works on phones | Result in the PDF | Risks |
|---|---|---|---|---|---|---|
| A | **Use Edit PDF → Insert → Text Box** (no code; optionally a one-line hint in the app) | Switch to Edit PDF once, then Insert → Text Box and click where to type | 0, plus a 15-minute check (a hint: ~1 hour) | No | Text written into the page (to verify) | Edit PDF may be missing on our server; users must learn the mode switch; Edit PDF also lets people change the original page by accident |
| B | **Upgrade to ONLYOFFICE 10.0** and use No Fill per box | Text Comment, then right panel: background No Fill, border width 0 (each box) | 0.5–1 day (upgrade plus re-test of every editor feature) | No | Annotation | New release (3 days old); clicks on every box; defaults still white |
| C | **ONLYOFFICE plugin**: "Add text" and "Remove boxes" buttons | Click Add text, drag, type. Or use Text Comment, then Remove boxes | 1–1.5 days (plugin files served by the app, `pluginsData` for PDFs only in `editorConfig.ts`, tests) | No | Annotation | Plugin APIs can change on upgrade (pinned version, re-test on upgrade); a toolbar button from a plugin in the PDF editor needs a quick check |
| D | **In-app "Fill in" tool** (pdf.js view, tap to place text, pdf-lib writes real text, saved as a new version) | Open a PDF → Fill in, tap, type, Save | 3–4 days | **Yes** | Text written into the page (vector, Helvetica) | A second PDF tool beside ONLYOFFICE; standard fonts only cover Latin-1 (full Unicode would need `@pdf-lib/fontkit`, a new dependency); must refuse to save while the file is open in the editor, or save the way restore does |
| E | Add real form fields, then fill them | Draw a field per blank, then fill | 0 code, a lot of user effort | No | Fields | Rejected: worse than A for flat forms |

### Option D in more detail (the in-app fallback)

- **View:** reuse `src/components/PdfCanvas.tsx` and `src/utils/pdfDocCache.ts`, which already render pages with pdf.js for takeoffs.
- **Placing text:** tap on the page, type in a borderless input over it, drag to move, set the size (default 10 pt) and colour (default black). Text is stored in page-image coordinates, the same convention as the takeoff overlays.
- **Writing:** pdf-lib `page.drawText` with an embedded standard font, mapped from screen to page space with `viewBox` / `overlayPlacement` (`src/utils/pdfOverlayTransform.ts` l.34, l.58). Those helpers already handle rotated pages and odd CropBoxes. Unlike the editor removed in 4.0.0, which flattened everything into a PNG (`PdfEditor.tsx` `renderOverlay` / `buildAnnotatedPdf`), text stays sharp, searchable text.
- **Saving:** save as a new version through `POST /api/files/:id/versions` (`server/routes.ts` l.1553). If the file is open in ONLYOFFICE, either refuse with "close the editor first", or follow restore's sequence: save what is open, retire the session, then write the new version (`server/onlyoffice/historyRoutes.ts` l.194-240).

## §1 Pages inside the editor: findings

### P1. What 9.4 can do with pages

- Insert a blank page before or after, delete, rotate, and reorder by dragging thumbnails. Copy and paste uses `asc_AddPage`, `asc_RemovePage` and `Paste(isPastePageBefore)` (sdkjs `pdf/api.js` l.782-813 and l.3930; help center "Editing PDF"). These page commands live in Edit PDF mode on the Home tab. **Verify** whether the thumbnail panel also allows them in Annotate mode.
- **Copying pages between PDFs works**: select pages in the thumbnails, Ctrl+C, then Ctrl+V in another PDF's thumbnails. The engine serialises the selected pages into a small PDF (`nativeFile.SplitPages`, base64, on the clipboard). The paste merges it in with `MergePagesBinary` / `nativeFile.MergePages` (sdkjs `pdf/src/document.js` l.6508-6518, l.7528-7544). It goes through co-editing history (`CChangesPDFDocumentPartMergePages`). ONLYOFFICE staff gave the same workaround on 2026-02-27.
- In this app that means opening both PDFs in the Document Editor, in two browser tabs. **Verify** that the clipboard carries pages between tabs. Also test a large plan set: a 50 MB copy through the clipboard may be slow or refused.

### P2. No "insert pages from a file"

- It isn't in the 9.4 Insert tab (help center: blank page, table, text box, Text Art, image, shapes, hyperlink, equation). It isn't in 10.0 either: there's no such code in web-apps or sdkjs `v10.0.0.99`, and the only "From file" in the PDF menus is for replacing images. On 2026-03-02 staff logged "insert pages from an unopened PDF" as a feature suggestion, with no date.
- The plugin and document-building APIs can't do it either. `ApiDocument.AddPage` makes blank pages only (sdkjs `pdf/apiBuilder.js` l.8526), and no plugin method accepts a file.
- A plugin could reach the internal `MergePagesBinary` from `callCommand`, but that is undocumented and could break on any upgrade. **Rejected.**

### P3. What the app can add

- **G1. Copy and paste (no code).** Tell users how; the hands-on check proves it works.
- **G2. Page picking in T12's Append pages dialog (recommended).** For each source PDF, show thumbnails with checkboxes or a range field ("1-3, 7"), and let the user choose where the pages go: at the end (the default), at the start, or after page N. The server uses the shared T11 helper (pdf-lib `copyPages` with an index list, the same approach as `src/utils/pdfAttachments.ts` l.16-35) and saves a new version. It works on phones and outside the editor. Effort: about +1 day on top of T12. The helper's interface should take `{ fileId, pages?: number[] }[]` and `insertAt`, so T11 and T12 should know this before they start.
- **G3. "Insert pages…" button in the Document Editor's header (later, optional).** For an open PDF in edit mode, open the same dialog. The server first asks ONLYOFFICE to save what is open, then retires that session and writes the new version. That copies restore's sequence (`historyRoutes.ts` l.194-240: `requestForcesave`, `waiters.wait`, `sessions.supersede`, `saveNewVersion`); the editor then reopens on the new version (`DocumentEditor.tsx` restarts on a new generation). As with restore, refuse while someone else is editing. Effort: 1.5–2 days after G2. The app can't see which page is selected in ONLYOFFICE without a plugin, so the position comes from the dialog.

## Recommendation

1. **§2 now: option A, checked by hand (T15).** If Edit PDF → Text Box gives borderless text that survives saving, §2 needs no code. At most it needs a short hint the first time a PDF opens in the editor ("To type on a form: Edit PDF → Insert → Text Box").
2. **If A fails or is too awkward: option C (plugin), 1–1.5 days.** It works in the default Annotate mode, needs no upgrade and no new npm dependency, and keeps text editable.
3. **Option D only if forms are filled on phones.** It is the only option that works there, and it gives the cleanest output, at 3–4 days and a second PDF tool to maintain.
4. **Upgrade to 10.0 (B) later, as its own planned task.** It is useful (No Fill per box), but it isn't a §2 fix by itself.
5. **§1:** build G2 (page picking and insert position) into T11/T12 now. Point users to copy and paste between open PDFs (G1) for page work inside the editor. Build G3 only if the owner asks again after trying G1 and G2.

## Hands-on check (15 minutes on docs-test, for T15)

1. Open a flat PDF form in the Document Editor on desktop. Comment → Text Comment: confirm it makes the white box with a border, and that its pop-up bar has no fill or border-width option.
2. Switch the mode to **Edit PDF**. Is the switch there on our Community Edition? Does the Insert tab appear?
3. Insert → Text Box, click on a form blank and type. Confirm there is no fill and no border, and that font and size can be changed.
4. Save, close, and open the saved version in Chrome's PDF viewer and in Acrobat. Is the text there and in the right place? Print preview: does it print?
5. Thumbnails: select two pages, Ctrl+C. Open a second PDF in another tab, click its thumbnails, Ctrl+V. Do the pages arrive? Save and check the version.
6. Are Insert page, Delete page and Rotate available in Annotate mode, or only in Edit PDF?

## Risks and notes

- All line numbers for ONLYOFFICE refer to tags `v9.4.0.97` and `v10.0.0.99` of `ONLYOFFICE/sdkjs` and `ONLYOFFICE/web-apps`. App line numbers are as of commit 23567d6.
- The help center pages describe the current release, which can be ahead of 9.4. The callout page already describes the 10.0 Annotation Settings panel. The source code is the authority for 9.4.
- Options C and G3 run against an open editing session. Both reuse the existing session and save machinery (`server/onlyoffice/sessions.ts`), so no new way of overwriting a file is introduced.
- Option D and G2 add no dependency. Unicode text in D would need `@pdf-lib/fontkit`, which is a new dependency, so leave it out unless asked.
