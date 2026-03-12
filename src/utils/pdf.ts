import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';

// Configure the worker to use the local version matching the installed pdfjs-dist version
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfPageImage {
  dataUrl: string;
  width: number;
  height: number;
  pageNum: number;
  suggestedName?: string;
  extractedText?: string;
}

export const loadPdfAllPagesAsImages = async (
  file: File, 
  onProgress?: (pageNum: number, totalPages: number) => void
): Promise<PdfPageImage[]> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pages: PdfPageImage[] = [];

  let pageLabels: string[] | null = null;
  try {
    pageLabels = await pdf.getPageLabels();
  } catch (e) {
    console.warn('Could not get page labels', e);
  }

  for (let i = 1; i <= totalPages; i++) {
    if (onProgress) onProgress(i, totalPages);
    
    const page = await pdf.getPage(i);
    
    // Use a higher scale for better resolution when zooming in
    const scale = 2.0;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    if (!context) {
      throw new Error('Could not create canvas context');
    }
    
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    await page.render({ canvasContext: context, viewport } as any).promise;
    
    let extractedText = '';
    try {
      const textContent = await page.getTextContent();
      extractedText = textContent.items.map((item: any) => item.str).join(' ');
    } catch (e) {
      console.warn('Could not extract text from page', e);
    }
    
    // Fallback to OCR if no text was extracted (e.g. image-based PDF)
    if (!extractedText || extractedText.trim().length < 5) {
      try {
        const { data: { text } } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng');
        extractedText = text;
      } catch (ocrError) {
        console.warn('OCR failed', ocrError);
      }
    }
    
    let suggestedName = `Page ${i}`;
    
    // Try to find a sheet number in the extracted text
    const sheetNumberPatterns = [
      /\bSheet\s*(?:No\.?|#|Number|Num\.?)?\s*([A-Z0-9.-]{2,10})\b/gi, // Sheet No. A101, Sheet #101, Sheet A101, Sheet Number A101
      /\b([A-Z]{1,2}-?\d{1,3}(?:\.[A-Z0-9]+)?)\b/g,                    // A-101, S1.1, ME-201
      /\bPage\s+(\d+)\b/gi                                             // Page 1
    ];

    let foundSheetNumber = '';

    // Helper to validate if a string looks like a sheet number
    const isValidSheetNumber = (str: string) => {
      if (!str) return false;
      const s = str.toLowerCase().trim();
      // Exclude common words that might be captured by mistake
      if (['number', 'no', 'page', 'sheet', 'of', 'total'].includes(s)) return false;
      // Should have at least one digit or be a common short code like "A", "S", "M"
      return /\d/.test(s) || (s.length >= 1 && s.length <= 6 && /[A-Z]/i.test(s));
    };

    // First pass: look for explicit "Sheet" labels which are high confidence
    const explicitSheetMatch = extractedText.match(/\bSheet\s*(?:No\.?|#|Number|Num\.?)?\s*([A-Z0-9.-]{2,10})\b/i);
    if (explicitSheetMatch && isValidSheetNumber(explicitSheetMatch[1])) {
      foundSheetNumber = explicitSheetMatch[1].trim();
    } else {
      // Second pass: look for common blueprint patterns
      // We look for all matches and often the one in the title block is near the end of the text stream
      const allMatches: string[] = [];
      for (const pattern of sheetNumberPatterns) {
        const matches = [...extractedText.matchAll(pattern)];
        matches.forEach(m => {
          if (isValidSheetNumber(m[1])) {
            allMatches.push(m[1].trim());
          }
        });
      }
      
      if (allMatches.length > 0) {
        // Filter out common false positives (like "2024", "1234" if they don't look like sheet numbers)
        // For now, we'll take the last match that has a letter or is a likely sheet number
        const likelySheet = allMatches.reverse().find(m => /[A-Z]/i.test(m) || m.length <= 4);
        if (likelySheet) {
          foundSheetNumber = likelySheet;
        }
      }
    }

    if (foundSheetNumber) {
      suggestedName = foundSheetNumber;
    } else if (totalPages === 1) {
      // If it's a single page PDF, use the file name without extension
      suggestedName = file.name.replace(/\.[^/.]+$/, "");
    } else if (pageLabels && pageLabels[i - 1]) {
      // If it's a multi-page PDF and has page labels, use the label
      suggestedName = pageLabels[i - 1];
    }
    
    pages.push({
      dataUrl: canvas.toDataURL('image/png'),
      width: viewport.width,
      height: viewport.height,
      pageNum: i,
      suggestedName,
      extractedText,
    });
  }
  
  return pages;
};
