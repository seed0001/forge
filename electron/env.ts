import fs from 'node:fs';

export function loadEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) process.env[key] = value;
  }
}

/**
 * Updates (or appends) a single KEY=value line in a .env file, leaving every
 * other line untouched. Used to make a model chosen at runtime survive a
 * restart, the same way editing .env by hand would.
 */
export function setEnvValue(envPath: string, key: string, value: string): void {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  let found = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq !== -1 && trimmed.slice(0, eq).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(envPath, next.join('\n'));
}
