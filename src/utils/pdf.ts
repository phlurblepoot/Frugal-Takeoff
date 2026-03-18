import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';

// Configure the worker to use the local version matching the installed pdfjs-dist version
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfPageImage {
  dataUrl: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  pageNum: number;
  suggestedName?: string;
  extractedText?: string;
}

export const loadPdfPagesGenerator = async function*(
  file: File, 
  onProgress?: (status: string, pageNum: number, totalPages: number) => void
): AsyncGenerator<PdfPageImage, void, unknown> {
  const fileUrl = URL.createObjectURL(file);
  const getPdfDoc = () => pdfjsLib.getDocument({ 
    url: fileUrl,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/standard_fonts/',
  }).promise;

  let pdf = await getPdfDoc();
  const totalPages = pdf.numPages;

  let pageLabels: string[] | null = null;
  try {
    pageLabels = await pdf.getPageLabels();
  } catch (e) {
    console.warn('Could not get page labels', e);
  }

  let tesseractWorker: Tesseract.Worker | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const thumbCanvas = document.createElement('canvas');
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

  if (!context || !thumbCtx) {
    throw new Error('Could not create canvas context');
  }

  try {
    for (let i = 1; i <= totalPages; i++) {
      if (onProgress) onProgress('processing the image', i, totalPages);
      
      const page = await pdf.getPage(i);
      
      // Use a higher scale for better resolution when zooming in
      const scale = 2.0;
      const viewport = page.getViewport({ scale });
      
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      // Fill with white background for JPEG conversion
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      
      await page.render({ canvasContext: context, viewport } as any).promise;
      
      if (onProgress) onProgress('reading the text', i, totalPages);
      let extractedText = '';
      try {
        const textContent = await page.getTextContent();
        extractedText = textContent.items.map((item: any) => item.str).join(' ');
      } catch (e) {
        console.warn('Could not extract text from page', e);
      }
      
      // Fallback to OCR if no text was extracted (e.g. image-based PDF)
      if (!extractedText || extractedText.trim().length < 5) {
        if (onProgress) onProgress('reading the text', i, totalPages);
        try {
          if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('eng');
          }
          const { data: { text } } = await tesseractWorker.recognize(canvas);
          extractedText = text;
          
          if (i % 10 === 0) {
            await tesseractWorker.terminate();
            tesseractWorker = null;
          }
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
      
      // Generate a smaller thumbnail
      const thumbScale = 400 / Math.max(viewport.width, viewport.height);
      thumbCanvas.width = viewport.width * thumbScale;
      thumbCanvas.height = viewport.height * thumbScale;
      thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.5);

      page.cleanup();

      if (i % 10 === 0 && typeof pdf.cleanup === 'function') {
        try {
          await pdf.cleanup();
        } catch (e) {
          console.warn('pdf.cleanup failed', e);
        }
      }

      if (i % 50 === 0 && i < totalPages) {
        try {
          await pdf.destroy();
          pdf = await getPdfDoc();
        } catch (e) {
          console.warn('pdf reload failed', e);
        }
      }

      yield {
        dataUrl,
        thumbnailDataUrl,
        width: viewport.width,
        height: viewport.height,
        pageNum: i,
        suggestedName,
        extractedText,
      };

      // Small delay to allow garbage collection and UI updates
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (tesseractWorker) {
      await tesseractWorker.terminate();
    }
    await pdf.destroy();
    URL.revokeObjectURL(fileUrl);
    
    // Free canvas memory
    canvas.width = 0;
    canvas.height = 0;
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;
  }
};
