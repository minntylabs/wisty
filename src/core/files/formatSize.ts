export const formatSizeMb = (sizeBytes: number): string =>
  (sizeBytes / (1024 * 1024)).toFixed(1);
