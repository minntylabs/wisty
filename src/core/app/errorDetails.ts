/**
 * Turning an error's details into something a person can read.
 *
 * This used to be `JSON.stringify(details, null, 2)`, which is right for the
 * shapes it was written for — a path, a size, a code — and wrong for the one
 * that matters most. ffmpeg's output arrives here as many lines, and JSON has
 * no way to write a line break: a log becomes one long line of `\n` escapes
 * inside quotes, and the copy button hands the user that same escaped form to
 * paste into a bug report.
 *
 * So text is printed as text, and only what is genuinely structured is printed
 * as JSON.
 */

/** The heading a multi-line value is printed under. */
const asBlock = (key: string, body: string) => `${key}:\n${body}`;

const isScalar = (value: unknown) =>
  typeof value === "number" || typeof value === "boolean" || value === null;

/** Whether every member is a string, which is what a captured log looks like. */
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((member) => typeof member === "string");

const formatValue = (key: string, value: unknown): string => {
  // A log, however it was handed over: as the lines it was read as, or already
  // joined. Either way it is text, and prints as the lines it is.
  if (isStringList(value)) {
    return value.length === 0 ? `${key}: (none)` : asBlock(key, value.join("\n"));
  }
  if (typeof value === "string") {
    return value.includes("\n") ? asBlock(key, value) : `${key}: ${value}`;
  }
  if (isScalar(value)) {
    return `${key}: ${String(value)}`;
  }
  if (value === undefined) {
    return `${key}: (not given)`;
  }
  // An object or a mixed array: genuinely structured, so JSON is the honest
  // rendering rather than an accident of the transport.
  try {
    return asBlock(key, JSON.stringify(value, null, 2));
  } catch {
    return `${key}: (cannot be shown)`;
  }
};

/**
 * The whole details block, one entry per line or per paragraph.
 *
 * Returns "" for nothing worth showing, which is what the caller tests to
 * decide whether there is anything to reveal or to copy.
 */
export const formatErrorDetails = (details: Record<string, unknown> | null | undefined): string => {
  if (!details) {
    return "";
  }
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return "";
  }
  // Blank line between entries: a log runs to many lines, and without a gap the
  // next key reads as one more line of it.
  return entries.map(([key, value]) => formatValue(key, value)).join("\n\n");
};
