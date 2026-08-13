/** Empty suggestion text for info / audit events. */
export function displayFixForSeverity(
  stored: string | null | undefined,
  severity: string | null | undefined,
  fallback: (s: string | null | undefined) => string,
): string {
  if ((severity || '').toLowerCase() === 'info') {
    return '';
  }
  return fallback(stored);
}
