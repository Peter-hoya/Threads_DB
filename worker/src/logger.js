function errorFields(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    retryable: error.retryable,
    details: error.details,
    stack: process.env.LOG_STACKS === '1' ? error.stack : undefined,
  };
}

export function createLogger(output = console) {
  function write(level, event, fields = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    output[level === 'error' ? 'error' : 'log'](JSON.stringify(record));
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, error, fields = {}) => write('error', event, { ...fields, error: errorFields(error) }),
  };
}
