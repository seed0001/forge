// Minimal ANSI escape sequence stripper so raw command output reads cleanly
// in a plain-text log panel instead of a full terminal emulator.
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
