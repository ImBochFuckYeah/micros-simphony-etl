interface LogContext {
  [key: string]: unknown;
}

const write = (level: "info" | "error", message: string, context?: LogContext): void => {
  const payload = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...context
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

export const logger = {
  info: (message: string, context?: LogContext): void => write("info", message, context),
  error: (message: string, context?: LogContext): void => write("error", message, context)
};
