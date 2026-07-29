interface LogContext {
  [key: string]: unknown;
}

interface InactivityWatchdog {
  timeoutMs: number;
  label: string;
  timer: NodeJS.Timeout | null;
}

let inactivityWatchdog: InactivityWatchdog | null = null;

const stopInactivityWatchdog = (): void => {
  if (!inactivityWatchdog) return;

  if (inactivityWatchdog.timer) {
    clearTimeout(inactivityWatchdog.timer);
  }

  inactivityWatchdog = null;
};

const scheduleInactivityWatchdog = (): void => {
  if (!inactivityWatchdog) return;

  if (inactivityWatchdog.timer) {
    clearTimeout(inactivityWatchdog.timer);
  }

  inactivityWatchdog.timer = setTimeout(() => {
    const payload = {
      level: "error",
      timestamp: new Date().toISOString(),
      message: "Execution stopped due to 3 minutes without logs",
      label: inactivityWatchdog?.label,
      timeoutMs: inactivityWatchdog?.timeoutMs
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exit(1);
  }, inactivityWatchdog.timeoutMs);
};

const write = (level: "info" | "error", message: string, context?: LogContext): void => {
  const payload = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...context
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);

  if (inactivityWatchdog) {
    scheduleInactivityWatchdog();
  }
};

export const logger = {
  info: (message: string, context?: LogContext): void => write("info", message, context),
  error: (message: string, context?: LogContext): void => write("error", message, context)
};

export const startLoggerInactivityWatchdog = (timeoutMs: number, label: string): void => {
  inactivityWatchdog = {
    timeoutMs,
    label,
    timer: null
  };

  scheduleInactivityWatchdog();
};

export const stopLoggerInactivityWatchdog = (): void => {
  stopInactivityWatchdog();
};
