#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const PO_UMOLCHANIYU = fileURLToPath(new URL('../.github/workflows/deploy.yml', import.meta.url));
const PO_UMOLCHANIYU_CI = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const PUT = process.argv[2] ?? PO_UMOLCHANIYU;
const PUT_CI = process.argv[3] ?? PO_UMOLCHANIYU_CI;
const REPOZITORIY = 'TeamVm2026/LandingMN';

const SHA_WRANGLER_ACTION = 'ebbaa1584979971c8614a24965b4405ff95890e0';

const OBYAZATELNYE = [
  ['успех прогона CI', "conclusion == 'success'"],
  ['происхождение прогона', 'head_repository.full_name == github.repository'],
];

let otkazov = 0;
const otkaz = (tekst) => {
  otkazov += 1;
  console.log(`  ОТКАЗ ПРИБОРА: ${tekst}`);
};

const LEKSEMA =
  /\s+|'(?:[^']|'')*'|==|!=|&&|\|\||\(|\)|github(?:\.[A-Za-z_][A-Za-z0-9_-]*)+/y;

function razobrat(vyrazhenie) {
  const obramlenie = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(vyrazhenie);
  if (!obramlenie) {
    throw new Error(`выражение не обрамлено фигурными скобками шаблона: ${vyrazhenie}`);
  }
  const telo = obramlenie[1];
  const leksemy = [];
  let poziciya = 0;
  while (poziciya < telo.length) {
    LEKSEMA.lastIndex = poziciya;
    const sovpadenie = LEKSEMA.exec(telo);
    if (!sovpadenie) {
      throw new Error(
        `непонятая лексема на позиции ${poziciya}: ` +
          JSON.stringify(telo.slice(poziciya, poziciya + 40)),
      );
    }
    const kusok = sovpadenie[0];
    poziciya += kusok.length;
    if (!/^\s+$/.test(kusok)) leksemy.push(kusok);
  }
  if (leksemy.length === 0) throw new Error('пустое выражение');
  return leksemy;
}

function znachenie_puti(kontekst, put) {
  let uzel = kontekst;
  for (const shag of put.split('.')) {
    if (uzel === null || uzel === undefined || typeof uzel !== 'object') return undefined;
    uzel = uzel[shag];
  }
  return uzel;
}

function vychislit(vyrazhenie, kontekst) {
  const leksemy = razobrat(vyrazhenie);
  const js = leksemy
    .map((l) => {
      if (l === '==') return '===';
      if (l === '!=') return '!==';
      if (l === '&&' || l === '||' || l === '(' || l === ')') return l;
      if (l.startsWith("'")) {
        return JSON.stringify(l.slice(1, -1).split("''").join("'"));
      }

      const znach = znachenie_puti(kontekst, l);
      return znach === undefined ? 'undefined' : JSON.stringify(znach);
    })
    .join(' ');
  return Boolean(new Function(`return (${js});`)());
}

function kontekst_sluchaya(s) {
  return {
    github: {
      repository: REPOZITORIY,
      event: {
        workflow_run: {
          event: s.sobytie,
          conclusion: s.itog,
          head_branch: s.vetka,
          head_repository: { full_name: s.istochnik },
        },
      },
    },
  };
}

console.log(`Прибор охраны воркфлоу выкладки. Файлы: ${PUT} и ${PUT_CI}`);
const tekst = readFileSync(PUT, 'utf8');
const doc = parse(tekst);
const zadaniya = doc?.jobs ?? {};

console.log('');
console.log('[A] Структурная проверка заданий, видящих секреты');
let vidyat_sekrety = 0;
for (const [imya, zadanie] of Object.entries(zadaniya)) {
  const podderevo = stringify(zadanie ?? null);
  if (!podderevo.includes('secrets.')) {
    console.log(`  задание "${imya}": секретов не видит — заградитель не требуется`);
    continue;
  }
  vidyat_sekrety += 1;
  const uslovie = typeof zadanie?.if === 'string' ? zadanie.if : '';
  if (!uslovie) {
    otkaz(`задание "${imya}" видит секреты и НЕ имеет job-level if вовсе`);
    continue;
  }
  for (const [imya_klauzy, obrazec] of OBYAZATELNYE) {
    if (uslovie.includes(obrazec)) {
      console.log(`  задание "${imya}": клауза «${imya_klauzy}» — есть`);
    } else {
      otkaz(
        `задание "${imya}" видит секреты, но не несёт клаузу «${imya_klauzy}» (${obrazec})`,
      );
    }
  }
}
if (vidyat_sekrety === 0) {
  otkaz('ни одно задание не видит секреты — прибор меряет не тот файл');
}

const zadanie_deploy = zadaniya.deploy;
if (!zadanie_deploy) otkaz('в файле нет задания deploy');

const uslovie_zadaniya = typeof zadanie_deploy?.if === 'string' ? zadanie_deploy.if : null;
if (!uslovie_zadaniya) otkaz('у задания deploy нет job-level if');

const shag_vorkera = (zadanie_deploy?.steps ?? []).find(
  (sh) => typeof sh?.if === 'string' && sh.if.includes('head_branch'),
);
if (!shag_vorkera) otkaz('шаг воркера бота потерял собственный if по head_branch');

const TABLICA = [
  { n: 1, sobytie: 'push',         istochnik: REPOZITORIY,          vetka: 'main',      itog: 'success', zadanie: 'ПУСК',  vorker: 'ПУСК'  },
  { n: 2, sobytie: 'push',         istochnik: REPOZITORIY,          vetka: 'feature/x', itog: 'success', zadanie: 'ПУСК',  vorker: 'ОТКАЗ' },
  { n: 3, sobytie: 'pull_request', istochnik: REPOZITORIY,          vetka: 'feature/x', itog: 'success', zadanie: 'ПУСК',  vorker: 'ОТКАЗ' },
  { n: 4, sobytie: 'pull_request', istochnik: 'attacker/LandingMN', vetka: 'main',      itog: 'success', zadanie: 'ОТКАЗ', vorker: 'ОТКАЗ' },
  { n: 5, sobytie: 'push',         istochnik: 'attacker/LandingMN', vetka: 'main',      itog: 'success', zadanie: 'ОТКАЗ', vorker: 'ОТКАЗ' },
  { n: 6, sobytie: 'push',         istochnik: REPOZITORIY,          vetka: 'main',      itog: 'failure', zadanie: 'ОТКАЗ', vorker: 'ОТКАЗ' },
  { n: 7, sobytie: 'pull_request', istochnik: 'attacker/LandingMN', vetka: 'evil',      itog: 'success', zadanie: 'ОТКАЗ', vorker: 'ОТКАЗ' },
];

console.log('');
console.log(`[Б/В] Таблица контекстов (github.repository = ${REPOZITORIY})`);
console.log(
  '  #  событие       происхождение             ветка       итог CI   задание ож/пол        воркер ож/пол',
);
for (const s of TABLICA) {
  const ktx = kontekst_sluchaya(s);
  let zad = '—';
  let vor = '—';
  try {
    zad = uslovie_zadaniya && vychislit(uslovie_zadaniya, ktx) ? 'ПУСК' : 'ОТКАЗ';
    const shag = shag_vorkera ? vychislit(shag_vorkera.if, ktx) : false;
    vor = zad === 'ПУСК' && shag ? 'ПУСК' : 'ОТКАЗ';
  } catch (e) {
    otkaz(`случай ${s.n}: ${e.message}`);
  }
  const sovpalo = zad === s.zadanie && vor === s.vorker;
  console.log(
    `  ${s.n}  ${s.sobytie.padEnd(13)} ${s.istochnik.padEnd(25)} ${s.vetka.padEnd(11)} ` +
      `${s.itog.padEnd(9)} ${`${s.zadanie}/${zad}`.padEnd(21)} ${`${s.vorker}/${vor}`.padEnd(18)}` +
      `${sovpalo ? 'ok' : 'РАСХОЖДЕНИЕ'}`,
  );
  if (!sovpalo) {
    otkazov += 1;
    if (s.n === 4) {
      console.log(
        '     ⛔ ЭТО ТА САМАЯ ДЫРА: чужой форк с веткой main доезжает до боевого воркера, принимающего лиды.',
      );
    }
  }
}

console.log('');
console.log('[Г] Очередь выкладок и потолок времени');
const ochered = doc?.concurrency;
if (!ochered || typeof ochered !== 'object') {
  otkaz('в deploy.yml нет ключа concurrency — две выкладки могут разъехаться молча');
} else {
  const gruppa = typeof ochered.group === 'string' ? ochered.group : '';
  if (!gruppa.includes('head_branch')) {
    otkaz(
      `группа очереди не называет ветку (${JSON.stringify(gruppa)}): превью разных веток ` +
        'встанут в одну очередь, а гонка бывает только внутри одной',
    );
  } else {
    console.log(`  группа очереди: ${gruppa}`);
  }
  if (ochered['cancel-in-progress'] !== false) {
    otkaz(
      'cancel-in-progress обязан быть false: отменённая на середине выкладка оставит прод ' +
        'на прежнем коммите так же тихо, а воркер бота — в неизвестном состоянии',
    );
  } else {
    console.log('  cancel-in-progress: false — идущая выкладка не прерывается');
  }
}
const potolok = zadanie_deploy?.['timeout-minutes'];
if (typeof potolok !== 'number' || !Number.isFinite(potolok) || potolok <= 0 || potolok > 60) {
  otkaz(
    `у задания deploy нет разумного timeout-minutes (сейчас ${JSON.stringify(potolok)}): без него ` +
      'зависший npm ci/build/wrangler держит раннер до умолчания GitHub — шесть часов',
  );
} else {
  console.log(`  потолок времени задания deploy: ${potolok} мин`);
}

console.log('');
console.log('[Д] Гигиена шагов wrangler-action');
const shagi_deploy = Array.isArray(zadanie_deploy?.steps) ? zadanie_deploy.steps : [];
const shagi_wrangler = shagi_deploy.filter(
  (sh) => typeof sh?.uses === 'string' && sh.uses.startsWith('cloudflare/wrangler-action@'),
);
if (shagi_wrangler.length === 0) {
  otkaz('в задании deploy нет ни одного шага wrangler-action — прибор меряет не тот файл');
}
for (const sh of shagi_wrangler) {
  const imya = sh.name ?? sh.uses;
  const sha = sh.uses.split('@')[1] ?? '';
  if (sha !== SHA_WRANGLER_ACTION) {
    otkaz(
      `шаг "${imya}" закреплён SHA ${sha}, а разбор механизма исполнения command сделан для ` +
        `${SHA_WRANGLER_ACTION}. Перепроверить врезку у шага Pages в deploy.yml и обновить ` +
        'эту константу ВМЕСТЕ с SHA.',
    );
  } else {
    console.log(`  шаг "${imya}": SHA совпадает с разобранной сборкой`);
  }
  const skl = sh?.with && typeof sh.with === 'object' ? sh.with : {};
  for (const klyuch of ['preCommands', 'postCommands']) {
    if (klyuch in skl) {
      otkaz(
        `шаг "${imya}" несёт ${klyuch}: эти ключи идут через ОБОЛОЧКУ (execShell → /bin/sh -c), ` +
          'и подстановка выражения в них исполнима. Выносить в отдельный шаг run: с env: и ' +
          'без интерполяции недоверенных значений.',
      );
    }
  }
}

console.log('');
console.log('[Е] Версия Node берётся из .nvmrc');
let shagov_node = 0;
for (const [imya_fayla, put_fayla] of [
  ['deploy.yml', PUT],
  ['ci.yml', PUT_CI],
]) {
  let dokument;
  try {
    dokument = imya_fayla === 'deploy.yml' ? doc : parse(readFileSync(put_fayla, 'utf8'));
  } catch (e) {
    otkaz(`не прочитал ${imya_fayla} (${put_fayla}): ${e.message}`);
    continue;
  }
  for (const [imya_zadaniya, zadanie] of Object.entries(dokument?.jobs ?? {})) {
    for (const sh of Array.isArray(zadanie?.steps) ? zadanie.steps : []) {
      if (typeof sh?.uses !== 'string' || !sh.uses.startsWith('actions/setup-node@')) continue;
      shagov_node += 1;
      const skl = sh?.with && typeof sh.with === 'object' ? sh.with : {};
      const adres = `${imya_fayla} → задание "${imya_zadaniya}"`;
      if ('node-version' in skl) {
        otkaz(
          `${adres}: setup-node задаёт node-version: ${JSON.stringify(skl['node-version'])} ` +
            'литералом. Плавающая мажорная версия означает, что зелёный CI вчера ничего не ' +
            'обещает про CI сегодня — брать node-version-file: .nvmrc.',
        );
      }
      if (skl['node-version-file'] !== '.nvmrc') {
        otkaz(
          `${adres}: setup-node не читает .nvmrc (node-version-file: ` +
            `${JSON.stringify(skl['node-version-file'])})`,
        );
      } else if (!('node-version' in skl)) {
        console.log(`  ${adres}: node-version-file: '.nvmrc'`);
      }
    }
  }
}
if (shagov_node === 0) {
  otkaz('ни одного шага setup-node не найдено — обход пуст, прибор меряет не те файлы');
}

console.log('');
if (otkazov === 0) {
  console.log(
    'ИТОГ: ЗЕЛЕНО — заградитель на месте (семь случаев совпали), очередь и потолок заданы, ' +
      'шаги wrangler-action чисты, версия Node берётся из .nvmrc.',
  );
  process.exit(0);
}
console.log(`ИТОГ: КРАСНО — расхождений и отказов: ${otkazov}.`);
process.exit(1);
