import { parentPort, workerData } from 'node:worker_threads';
import { parseSubscriptionHtml } from './subscription-parser.js';

try {
  parentPort?.postMessage({ subscriptions: parseSubscriptionHtml(String(workerData || '')) });
} catch (error) {
  parentPort?.postMessage({ error: (error as Error).message });
}
