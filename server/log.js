/**
 * Structured logging.
 *
 * console.error with a message was the whole story, so a failed ingestion run
 * left nothing queryable: no run id, no job name, no way to ask "how often has
 * this provider failed this week" without reading text. Every line is one JSON
 * object on stdout or stderr, which is what a log collector can index and what
 * `jq` can read locally.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serialiseError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  return {
    message: error.message ?? String(error),
    name: error.name ?? 'Error',
    // The stack is the single most useful field and the single largest, so it
    // is trimmed rather than dropped: the top frames are where the fault is.
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : undefined,
    cause: error.cause ? { message: error.cause.message ?? String(error.cause) } : undefined,
  };
}

export function createLogger({
  level = process.env.LOG_LEVEL ?? 'info',
  write = (line) => process.stdout.write(`${line}\n`),
  writeError = (line) => process.stderr.write(`${line}\n`),
  now = () => new Date().toISOString(),
  base = {},
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (levelName, message, fields = {}) => {
    if (LEVELS[levelName] < threshold) return null;
    const { error, ...rest } = fields;
    const entry = {
      at: now(),
      level: levelName,
      message,
      ...base,
      ...rest,
      ...(error ? { error: serialiseError(error) } : {}),
    };
    let line;
    try {
      line = JSON.stringify(entry);
    } catch {
      // A field that cannot be serialised must not silence the whole line:
      // losing a log entry is worse than losing one of its fields.
      line = JSON.stringify({ at: entry.at, level: levelName, message, serialisationFailed: true });
    }
    (LEVELS[levelName] >= LEVELS.error ? writeError : write)(line);
    return entry;
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    /** A logger that stamps every line with the same context, e.g. a run id. */
    child: (childBase) => createLogger({ level, write, writeError, now, base: { ...base, ...childBase } }),
  };
}

export const logger = createLogger();
