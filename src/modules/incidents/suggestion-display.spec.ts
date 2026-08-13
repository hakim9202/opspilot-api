import { displayFixForSeverity } from './suggestion-display';

describe('displayFixForSeverity', () => {
  const fallback = (s: string | null | undefined) => s || 'default suggestion';

  it('hides suggestion for info severity', () => {
    expect(displayFixForSeverity('do something', 'info', fallback)).toBe('');
    expect(displayFixForSeverity('do something', 'INFO', fallback)).toBe('');
  });

  it('shows suggestion for warning/critical', () => {
    expect(displayFixForSeverity('fix it', 'warning', fallback)).toBe('fix it');
    expect(displayFixForSeverity('fix it', 'critical', fallback)).toBe('fix it');
  });
});
