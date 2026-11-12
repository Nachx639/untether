import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Reporter, TestCase } from 'vitest/node';

const LOG_FILE = join(process.cwd(), 'test-memory.log');

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: formatBytes(usage.rss),
    heapTotal: formatBytes(usage.heapTotal),
    heapUsed: formatBytes(usage.heapUsed),
    external: formatBytes(usage.external),
    arrayBuffers: formatBytes(usage.arrayBuffers),
  };
}

// Immediate sync write with crash protection
function logToFile(message: string) {
  try {
    appendFileSync(LOG_FILE, `${message}\n`, { flag: 'a' });
    // Also log to stderr so it's visible even if process crashes
    process.stderr.write(`${message}\n`);
  } catch (error) {
    console.error('Failed to write to memory log:', error);
  }
}

export default class MemoryReporter implements Reporter {
  private startTime: number = 0;
  private currentTest: string = '';
  private currentFile: string = '';

  constructor() {
    // Setup signal handlers to capture crashes
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGUSR2', 'SIGABRT'];
    signals.forEach((signal) => {
      process.on(signal, () => {
        logToFile(`\n⚠️  Process received ${signal}`);
        logToFile(`Current test: ${this.currentTest}`);
        logToFile(`Current file: ${this.currentFile}`);
        logToFile(`Memory at crash: ${JSON.stringify(getMemoryUsage(), null, 2)}`);
        process.exit(1);
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logToFile(`\n💥 UNCAUGHT EXCEPTION`);
      logToFile(`Test: ${this.currentTest}`);
      logToFile(`File: ${this.currentFile}`);
      logToFile(`Error: ${error.message}`);
      logToFile(`Stack: ${error.stack}`);
      logToFile(`Memory: ${JSON.stringify(getMemoryUsage(), null, 2)}`);
      process.exit(1);
    });

    // Handle OOM errors specifically
    process.on('beforeExit', (code) => {
      if (code !== 0) {
        logToFile(`\n⚠️  Process exiting with code ${code}`);
        logToFile(`Last test: ${this.currentTest}`);
        logToFile(`Last file: ${this.currentFile}`);
        logToFile(`Final memory: ${JSON.stringify(getMemoryUsage(), null, 2)}`);
      }
    });
  }

  onInit() {
    this.startTime = Date.now();
    const initialMemory = getMemoryUsage();
    writeFileSync(LOG_FILE, `=== Test Run Started at ${new Date().toISOString()} ===\n`);
    logToFile(`Initial memory: ${JSON.stringify(initialMemory, null, 2)}\n`);
  }

  // Vitest 4 reports each test through these hooks; it no longer calls onTaskUpdate/onFinished.
  onTestCaseReady(testCase: TestCase) {
    this.logTest(testCase, 'run', 0);
  }

  onTestCaseResult(testCase: TestCase) {
    this.logTest(testCase, testCase.result().state, testCase.diagnostic()?.duration ?? 0);
  }

  private logTest(testCase: TestCase, state: string, duration: number) {
    const memory = getMemoryUsage();
    const fileName = testCase.module.relativeModuleId;

    // Update current test info
    if (state === 'run') {
      this.currentTest = testCase.name;
      this.currentFile = fileName;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      test: testCase.name,
      file: fileName,
      state,
      duration: `${duration}ms`,
      memory,
    };

    // Immediately write to file with sync IO
    logToFile(JSON.stringify(logEntry, null, 2));

    // Log to console for immediate visibility
    if (state === 'run') {
      console.log(`🏃 Running: ${testCase.name}`);
      console.log(`   Memory: heap=${memory.heapUsed}, rss=${memory.rss}`);
    } else if (state === 'passed') {
      console.log(`✅ Passed: ${testCase.name} (${duration}ms)`);
      // Check for high memory usage
      const heapMB = Number.parseFloat(memory.heapUsed);
      if (heapMB > 1000) {
        console.log(`   ⚠️  High memory usage: ${memory.heapUsed}`);
      }
    } else if (state === 'failed') {
      console.log(`❌ Failed: ${testCase.name}`);
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      const afterGC = getMemoryUsage();
      logToFile(`After GC: ${JSON.stringify(afterGC, null, 2)}`);
    }
  }

  onTestRunEnd() {
    const finalMemory = getMemoryUsage();
    const duration = Date.now() - this.startTime;

    logToFile(`\n=== Test Run Completed ===`);
    logToFile(`Total duration: ${duration}ms`);
    logToFile(`Final memory: ${JSON.stringify(finalMemory, null, 2)}`);

    console.log('\n📊 Memory Report saved to:', LOG_FILE);
  }
}
