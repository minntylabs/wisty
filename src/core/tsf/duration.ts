/**
 * How a length of recording is written for a person to read.
 *
 * One implementation, because there were two and they disagreed: the
 * conversion window's ran to hours, and the import's cue-problem messages did
 * not — so a ninety-minute interview, which is the ordinary case here, was
 * reported as "90:00 long".
 */

/** `m:ss`, or `h:mm:ss` past the hour, for a position or a length. */
export const formatDuration = (seconds: number): string => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  const paddedSeconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
};
