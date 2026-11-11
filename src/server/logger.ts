const REDACT = /^(body|bodyText|bodyHtml|text|html|subject|snippet|content|email|address|from|to|cc|token|accessToken|refreshToken|password|secret|code|authorization|cookie)$/i;

type Fields = Record<string, unknown>;

function scrub(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT.test(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) out[k] = scrub(v as Fields);
    else out[k] = v;
  }
  return out;
}

function write(level: "debug" | "info" | "warn" | "error", event: string, fields: Fields = {}) {
  if (process.env.APP_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...scrub(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (e: string, f?: Fields) => write("debug", e, f), info: (e: string, f?: Fields) => write("info", e, f),
  warn: (e: string, f?: Fields) => write("warn", e, f), error: (e: string, f?: Fields) => write("error", e, f),
};
