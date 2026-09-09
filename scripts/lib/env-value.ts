
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const ENV_FILES = ['.env.local', '.env.example'] as const;

export function envValue(key: string): string {

  if (key in process.env) return process.env[key] ?? '';

  for (const file of ENV_FILES) {
    const full = path.join(projectRoot, file);
    if (!existsSync(full)) continue;
    const match = readFileSync(full, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (match) return (match[1] ?? '').split('#')[0]!.trim();
  }

  throw new Error(
    `${key} не найден ни в process.env, ни в .env.local, ни в .env.example. ` +
      'Тест не имеет права угадывать значение: он сверяет кнопку с настройкой проекта.',
  );
}
