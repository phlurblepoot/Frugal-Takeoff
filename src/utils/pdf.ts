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
  onProgress?: (status: string, pageNum: number, totalPages: number) => void
): Promise<PdfPageImage[]> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ 
    data: arrayBuffer,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/standard_fonts/',
  }).promise;
  const totalPages = pdf.numPages;
  const pages: PdfPageImage[] = [];

  let pageLabels: string[] | null = null;
  try {
    pageLabels = await pdf.getPageLabels();
  } catch (e) {
    console.warn('Could not get page labels', e);
  }

  for (let i = 1; i <= totalPages; i++) {
    if (onProgress) onProgress('Converting pages', i, totalPages);
    
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
    
    if (onProgress) onProgress('Scanning text', i, totalPages);
    let extractedText = '';
    try {
      const textContent = await page.getTextContent();
      extractedText = textContent.items.map((item: any) => item.str).join(' ');
    } catch (e) {
      console.warn('Could not extract text from page', e);
    }
    
    // Fallback to OCR if no text was extracted (e.g. image-based PDF)
    if (!extractedText || extractedText.trim().length < 5) {
      if (onProgress) onProgress('Running OCR', i, totalPages);
      try {
        const { data: { text } } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng');
        extractedText = text;
      } catch (ocrError) {
        console.warn('OCR failed', ocrError);
      }
    }
    
    let suggestedName = `Page ${i}`;
    if (totalPages === 1) {
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
