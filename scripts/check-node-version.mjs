#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function razobrat(versiya, gde) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versiya.trim());
  if (!m) {
    console.error(`FAIL: не разобрал версию Node в ${gde}: ${JSON.stringify(versiya)}`);
    process.exit(1);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function sravnit(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

const nvmrcSyroy = readFileSync(path.join(KOREN, '.nvmrc'), 'utf8');
const trebuetsya = razobrat(nvmrcSyroy, '.nvmrc');
const trebuetsyaStr = trebuetsya.join('.');

const pkg = JSON.parse(readFileSync(path.join(KOREN, 'package.json'), 'utf8'));
const objyavlen = String(pkg?.engines?.node ?? '');
const polM = /^>=\s*(\d+\.\d+\.\d+)$/.exec(objyavlen);
if (!polM) {
  console.error(
    `FAIL: engines.node в package.json обязан иметь форму ">=X.Y.Z", а там ${JSON.stringify(objyavlen)}.`,
  );
  process.exit(1);
}
if (polM[1] !== trebuetsyaStr) {
  console.error(
    `FAIL: пол версии разошёлся с .nvmrc — engines.node объявляет >=${polM[1]}, ` +
      `а .nvmrc пинует ${trebuetsyaStr}. Правило проекта: версия задаётся в .nvmrc ` +
      `и нигде больше, package.json обязан её ПОВТОРЯТЬ, а не спорить с ней.`,
  );
  process.exit(1);
}

const tekushchaya = razobrat(process.version, 'process.version');
const otnoshenie = sravnit(tekushchaya, trebuetsya);

const OBHOD = (process.env.LANDINGMN_ALLOW_NODE_MISMATCH ?? '').trim() === '1';

if (otnoshenie < 0) {
  if (OBHOD) {
    console.warn(
      `WARN: Node ${process.version} НИЖЕ версии проекта ${trebuetsyaStr} (.nvmrc), но ` +
        'установка продолжена по LANDINGMN_ALLOW_NODE_MISMATCH=1. ⛔ Числа гейтов, снятые ' +
        'на этой версии, НЕ равны числам CI и не годятся для решений заказчика.',
    );
  } else {
    console.error(
      [
        `FAIL: Node ${process.version} НИЖЕ версии проекта ${trebuetsyaStr} (.nvmrc).`,
        '',
        'Почему это останавливает установку, а не печатает предупреждение:',
        'числа гейтов (check:perf, check:lighthouse, check:lead-unit) цитируются в',
        'решениях заказчика. Снятые на другой версии, чем считает CI, они врут молча —',
        'ровно так 09.09.2026 чужая ошибка node:test дважды заблокировала выкладку.',
        '',
        `Лечение: поставить Node ${trebuetsyaStr} (\`nvm install ${trebuetsyaStr} && nvm use ${trebuetsyaStr}\`).`,
        'Разовый осознанный обход, если установка нужна прямо сейчас:',
        '  LANDINGMN_ALLOW_NODE_MISMATCH=1 npm ci',
        '⛔ НЕ `--ignore-scripts`: он снимет и postinstall самого esbuild, который ставит',
        'платформенный двоичный файл, — сборка упадёт позже и по другой причине.',
      ].join('\n'),
    );
    process.exit(1);
  }
}

if (otnoshenie > 0) {

  console.warn(
    `WARN: Node ${process.version} ВЫШЕ версии проекта ${trebuetsyaStr} (.nvmrc). ` +
      'CI считает на .nvmrc — значит локальные числа могут не совпасть с числами CI. ' +
      'Именно более новая версия (22.23.2) привезла чужую ошибку node:test 09.09.2026.',
  );
}

console.log(`Node ${process.version} против .nvmrc ${trebuetsyaStr}: OK.`);
