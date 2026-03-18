import cluster from 'node:cluster';
import os from 'node:os';

const WORKER_COUNT = Math.min(os.cpus().length, 4);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} starting ${WORKER_COUNT} workers`);

  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal}) — restarting`);
    cluster.fork();
  });
} else {
  await import('./server.js');
}
