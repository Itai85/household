/**
 * Extract text from uploaded files.
 * - PDFs → pdfjs-dist (text layer extraction, no OCR needed for digital docs)
 * - Images → tesseract.js (on-device OCR)
 */

export interface OcrProgress {
  percent: number;
  status: string;
}

export async function extractText(
  file: File,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  if (file.type === 'application/pdf') {
    return extractPdfText(file, onProgress);
  }
  if (file.type.startsWith('image/')) {
    return ocrImage(file, onProgress);
  }
  throw new Error(`Unsupported file type: ${file.type}`);
}

async function extractPdfText(
  file: File,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  onProgress?.({ percent: 10, status: 'Loading PDF library...' });

  const pdfjsLib = await import('pdfjs-dist');

  // Set up the worker — use the bundled worker via URL
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();

  onProgress?.({ percent: 20, status: 'Reading PDF...' });
  const arrayBuffer = await file.arrayBuffer();

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  } catch (e) {
    // If worker fails, try without worker
    console.warn('PDF worker failed, trying inline:', e);
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  }

  const allLines: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.({ percent: 20 + Math.round((i / pdf.numPages) * 60), status: `Extracting page ${i}/${pdf.numPages}...` });
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // Group text items by Y position to reconstruct lines properly
    // PDF text items come with transform[5] = Y position (higher = higher on page)
    const itemsByLine: Map<number, { x: number; str: string }[]> = new Map();

    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const rawY = (item as any).transform[5] as number;
      const x = (item as any).transform[4] as number;
      // Round Y to nearest 3px bucket to group items on the same visual line
      // (PDF items on the same line can differ by 1-2px in Y position)
      const y = Math.round(rawY / 3) * 3;
      if (!itemsByLine.has(y)) itemsByLine.set(y, []);
      itemsByLine.get(y)!.push({ x, str: (item as any).str });
    }

    // Sort by Y descending (top of page first), then X ascending (left to right)
    const sortedYs = [...itemsByLine.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = itemsByLine.get(y)!.sort((a, b) => a.x - b.x);
      // Join items: use double-space when items are far apart (different columns in a table)
      let lineText = '';
      for (let j = 0; j < items.length; j++) {
        if (j === 0) {
          lineText = items[j]!.str;
        } else {
          const gap = items[j]!.x - (items[j - 1]!.x + items[j - 1]!.str.length * 4);
          lineText += (gap > 20 ? '   ' : ' ') + items[j]!.str;
        }
      }
      lineText = lineText.trim();
      if (lineText) allLines.push(lineText);
    }

    allLines.push(''); // page break
  }

  onProgress?.({ percent: 100, status: 'Done' });

  const text = allLines.join('\n');
  console.log('[PDF Extract] Extracted', allLines.filter(l => l).length, 'lines from', pdf.numPages, 'pages');
  console.log('[PDF Extract] First 500 chars:', text.slice(0, 500));

  return text;
}

async function ocrImage(
  file: File,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  onProgress?.({ percent: 5, status: 'Loading OCR engine...' });

  const Tesseract = await import('tesseract.js');
  onProgress?.({ percent: 15, status: 'Initialising OCR...' });

  const worker = await Tesseract.createWorker('eng', undefined, {
    logger: (m: any) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.({ percent: 15 + Math.round(m.progress * 80), status: 'Recognising text...' });
      }
    },
  });

  const { data } = await worker.recognize(file);
  await worker.terminate();

  onProgress?.({ percent: 100, status: 'Done' });

  console.log('[OCR] Extracted', data.text.split('\n').filter((l: string) => l.trim()).length, 'lines');
  console.log('[OCR] First 500 chars:', data.text.slice(0, 500));

  return data.text;
}
