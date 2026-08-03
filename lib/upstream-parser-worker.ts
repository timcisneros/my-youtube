import { parentPort } from 'node:worker_threads';
import { compactExtractionResult } from './extraction-result.js';

type ParseRequest = {
  id: number;
  operation: 'json' | 'embedded-json' | 'extraction-json';
  bytes: Uint8Array;
  marker?: string;
  extractedVia?: string;
};

function extractEmbeddedJson(text: string, marker: string) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) throw new Error(`${marker} not found`);
  const start = text.indexOf('{', markerIndex);
  if (start === -1) throw new Error(`${marker} object not found`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`${marker} object was incomplete`);
}

parentPort?.on('message', (request: ParseRequest) => {
  try {
    const text = Buffer.from(request.bytes).toString('utf8');
    let result;
    if (request.operation === 'embedded-json') {
      result = extractEmbeddedJson(text, request.marker || 'ytInitialData');
    } else {
      result = JSON.parse(text);
      if (request.operation === 'extraction-json') {
        result._extractedVia = request.extractedVia || 'yt-dlp';
        result = compactExtractionResult(result);
      }
    }
    parentPort?.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: (error as Error).message });
  }
});
