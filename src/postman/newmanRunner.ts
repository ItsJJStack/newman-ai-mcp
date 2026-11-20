/**
 * @fileoverview Newman execution wrapper (newmanRunner.ts).
 * Used by tools 4 (run_newman_collection) and 5 (generate_newman_report).
 * Ensures nothing is written to stdout and normalizes failures, timings, and console logs.
 */
import { safePath } from '../errors.js';
import { readFile } from 'node:fs/promises';

/** Normalized Newman failure returned by the runner. */
export type NewmanFailure = {
  itemName: string;
  itemPath: string[];
  iteration: number;
  type: 'assertion' | 'exception' | 'request';
  errorMessage: string;
  responseCode?: number;
  responseSnippet?: string;
};

export type NewmanRunOptions = {
  collection: any;
  environmentPath?: string;
  globalsPath?: string;
  envVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  iterationDataPath?: string;
  iterationCount?: number;
  folder?: string | string[];
  executionControl?: {
    delayRequest?: number;
    timeout?: number;
    timeoutRequest?: number;
    timeoutScript?: number;
    bail?: boolean;
    ignoreRedirects?: boolean;
    insecure?: boolean;
  };
  sslOptions?: {
    clientCertPath?: string;
    clientKeyPath?: string;
    passphrase?: string;
  };
  exports?: {
    environmentPath?: string;
    globalsPath?: string;
    collectionPath?: string;
  };
  reporters?: string[];
  reporter?: Record<string, any>;
};

export type NewmanRunResult = {
  success: boolean;
  aborted: boolean;
  stats: {
    iterations: { total: number; failed: number };
    requests: { total: number; failed: number };
    assertions: { total: number; failed: number };
    testScripts: { total: number; failed: number };
    prerequestScripts: { total: number; failed: number };
  };
  timings: { totalMs: number; avgResponseMs: number };
  failures: NewmanFailure[];
  truncated: boolean;
  consoleLogs: string[];
  exportedFiles: string[];
};

/**
 * Runs a collection programmatically with Newman without writing to stdout.
 */
export async function runCollection(options: NewmanRunOptions): Promise<NewmanRunResult> {
  const newman = await import('newman');

  // Traducir opciones al formato que espera newman.run
  const newmanOptions: any = {
    collection: options.collection,
    reporters: options.reporters || [],
    reporter: options.reporter || {},
  };

  if (options.environmentPath) {
    newmanOptions.environment = safePath(options.environmentPath);
  }
  if (options.globalsPath) {
    newmanOptions.globals = safePath(options.globalsPath);
  }
  if (options.envVars) {
    newmanOptions.envVar = Object.entries(options.envVars).map(([key, value]) => ({ key, value }));
  }
  if (options.globalVars) {
    newmanOptions.globalVar = Object.entries(options.globalVars).map(([key, value]) => ({ key, value }));
  }
  if (options.iterationDataPath) {
    newmanOptions.iterationData = safePath(options.iterationDataPath);
  }
  if (options.iterationCount) {
    newmanOptions.iterationCount = options.iterationCount;
  }
  if (options.folder) {
    newmanOptions.folder = options.folder;
  }

  const ctrl = options.executionControl || {};
  newmanOptions.timeout = ctrl.timeout ?? 300000;
  if (ctrl.delayRequest !== undefined) newmanOptions.delayRequest = ctrl.delayRequest;
  if (ctrl.timeoutRequest !== undefined) newmanOptions.timeoutRequest = ctrl.timeoutRequest;
  if (ctrl.timeoutScript !== undefined) newmanOptions.timeoutScript = ctrl.timeoutScript;
  if (ctrl.bail !== undefined) newmanOptions.bail = ctrl.bail;
  if (ctrl.ignoreRedirects !== undefined) newmanOptions.ignoreRedirects = ctrl.ignoreRedirects;
  if (ctrl.insecure !== undefined || options.executionControl?.insecure) {
    newmanOptions.insecure = true;
  }

  const ssl = options.sslOptions || {};
  if (ssl.clientCertPath) newmanOptions.sslClientCert = safePath(ssl.clientCertPath);
  if (ssl.clientKeyPath) newmanOptions.sslClientKey = safePath(ssl.clientKeyPath);
  if (ssl.passphrase) newmanOptions.sslClientPassphrase = ssl.passphrase;

  const exp = options.exports || {};
  if (exp.environmentPath) newmanOptions.exportEnvironment = safePath(exp.environmentPath);
  if (exp.globalsPath) newmanOptions.exportGlobals = safePath(exp.globalsPath);
  if (exp.collectionPath) newmanOptions.exportCollection = safePath(exp.collectionPath);

  const failures: NewmanFailure[] = [];
  const consoleLogs: string[] = [];
  let aborted = false;

  return new Promise((resolve) => {
    newman.run(newmanOptions, (err: any, summary: any) => {
      let success = !err && (!summary?.run?.failures || summary.run.failures.length === 0);

      if (err && err.message === 'callback timed out') {
        aborted = true;
        success = false;
      }

      const run = summary?.run || {};
      const stats = {
        iterations: { total: run.stats?.iterations?.total || 1, failed: run.stats?.iterations?.failed || 0 },
        requests: { total: run.stats?.requests?.total || 0, failed: run.stats?.requests?.failed || 0 },
        assertions: { total: run.stats?.assertions?.total || 0, failed: run.stats?.assertions?.failed || 0 },
        testScripts: { total: run.stats?.tests?.total || 0, failed: run.stats?.tests?.failed || 0 },
        prerequestScripts: { total: run.stats?.prerequests?.total || 0, failed: run.stats?.prerequests?.failed || 0 },
      };

      const timings = {
        totalMs: run.timings?.completed - run.timings?.started || 0,
        avgResponseMs: run.timings?.responseAverage || 0,
      };

      if (Array.isArray(run.failures)) {
        for (const f of run.failures) {
          const itemName = f.source?.name || f.item?.name || 'Unknown Item';
          // Construir itemPath
          const itemPath: string[] = [];
          let parent = f.parent;
          while (parent && parent.name) {
            itemPath.unshift(parent.name);
            parent = parent.parent;
          }

          const failType: 'assertion' | 'exception' | 'request' = f.error?.test ? 'assertion' : f.error?.code ? 'request' : 'exception';
          const errorMessage = f.error?.message || f.message || String(f.error || 'Unknown error');
          const responseCode = f.response?.code;
          let responseSnippet: string | undefined = undefined;

          if (f.response?.stream) {
            try {
              const bodyStr = Buffer.from(f.response.stream).toString('utf8');
              responseSnippet = bodyStr.slice(0, 1500);
            } catch {
              // Ignorar error de buffer
            }
          }

          failures.push({
            itemName,
            itemPath,
            iteration: f.cursor?.iteration || 0,
            type: failType,
            errorMessage,
            responseCode,
            responseSnippet,
          });
        }
      }

      const truncated = failures.length > 20;
      const limitedFailures = failures.slice(0, 20);

      const exportedFiles: string[] = [];
      if (exp.environmentPath) exportedFiles.push(exp.environmentPath);
      if (exp.globalsPath) exportedFiles.push(exp.globalsPath);
      if (exp.collectionPath) exportedFiles.push(exp.collectionPath);
      if (options.reporter) {
        for (const repConfig of Object.values(options.reporter) as any[]) {
          if (repConfig?.export) exportedFiles.push(repConfig.export);
        }
      }

      resolve({
        success,
        aborted,
        stats,
        timings,
        failures: limitedFailures,
        truncated,
        consoleLogs: consoleLogs.slice(0, 50),
        exportedFiles,
      });
    })
    .on('console', (e: any, args: any) => {
      if (args && Array.isArray(args.messages)) {
        for (const msg of args.messages) {
          consoleLogs.push(String(msg));
        }
      }
    });
  });
}
