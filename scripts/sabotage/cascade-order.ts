
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpDir = path.join(projectRoot, '.sabotage-tmp');

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-cascade-order.ts'],
};

function argPath(absolute: string): string {
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

function root(id: string): string {
  return path.join(tmpDir, `${id}-root`);
}

function gateCommand(id: string): string[] {
  return [
    '--experimental-strip-types',
    'scripts/check-cascade-order.ts',
    '--root',
    argPath(root(id)),
  ];
}

function layout(id: string, astro: string, css: string): void {
  const base = root(id);
  const components = path.join(base, 'src', 'components');
  const styles = path.join(base, 'src', 'styles');
  mkdirSync(components, { recursive: true });
  mkdirSync(styles, { recursive: true });

  mkdirSync(path.join(base, 'src', 'layouts'), { recursive: true });
  mkdirSync(path.join(base, 'src', 'pages'), { recursive: true });
  writeFileSync(path.join(components, 'Probe.astro'), astro, 'utf8');
  writeFileSync(path.join(styles, 'probe.css'), css, 'utf8');
}

function cleanup(id: string): void {
  rmSync(root(id), { recursive: true, force: true });
}

const ZDOROVYJ_ASTRO = `<div class="probe">проба</div>

<style>
  /* Обычная врезка без ловушек. */
  .probe {
    color: red;
  }

  @media (max-width: 859px) {
    .probe {
      padding: 4px;
    }
  }
</style>
`;

const ZDOROVYJ_CSS = `.probe-global {
  margin-top: 0;
}

@media (max-width: 859px) {
  .probe-global {
    margin-top: auto;
  }
}
`;

export const cases: SabotageCase[] = [
  {
    id: 'cascade-empty-scan',
    describe:
      'Стили переехали, а список обхода — нет: гейт обходит пустое дерево. До ' +
      '28.09.2026 он печатал OK на нуле блоков (находка C3-06) — ловушку ' +
      '«сокращёнка ниже медиазапроса» при этом не стерёг никто.',
    gate: 'check:cascade-order',
    greenRun: GREEN,
    expectOutputContains: 'ОБХОД ПУСТ',
    setup() {
      mkdirSync(root('cascade-empty-scan'), { recursive: true });
    },
    command: gateCommand('cascade-empty-scan'),
    teardown() {
      cleanup('cascade-empty-scan');
    },
  },
  {
    id: 'cascade-comment-broken-in-astro',
    gate: 'check:cascade-order',
    describe:
      'Последовательность «звёздочка-слеш» внутри текста врезки закрывает комментарий ' +
      'досрочно, и следующее объявление съедается вместе с остатком прозы. Ровно это ' +
      'случилось в LeadFormMarkup.astro и стоило живого box-shadow плюс 514 Б прозы ' +
      'в боевом CSS.',
    greenRun: GREEN,
    expectOutputContains: 'КЛАСС 1: комментарий закрывается раньше задуманного',
    setup() {
      layout(
        'cascade-comment-broken-in-astro',
        `<div class="probe">проба</div>

<style>
  /* Врезка, в тексте которой встречается пара --glass-rim-*/--glass-inset-*,
     из-за чего комментарий кончается раньше времени. */
  .probe {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12);
    color: red;
  }
</style>
`,
        ZDOROVYJ_CSS,
      );
    },
    command: gateCommand('cascade-comment-broken-in-astro'),
    teardown() {
      cleanup('cascade-comment-broken-in-astro');
    },
  },

  {
    id: 'cascade-comment-broken-in-css',
    gate: 'check:cascade-order',
    describe:
      'Тот же класс, но в отдельном листе стилей, а не в компоненте. Обход у гейта ' +
      'разный (`.astro` разбирается по блокам <style>, `.css` целиком), значит и ' +
      'краснота обязана доказываться отдельно: случай только для `.astro` оставил бы ' +
      'половину предмета непроверенной.',
    greenRun: GREEN,
    expectOutputContains: 'КЛАСС 1: комментарий закрывается раньше задуманного',
    setup() {
      layout(
        'cascade-comment-broken-in-css',
        ZDOROVYJ_ASTRO,
        `/* Врезка про пару --glass-rim-*/--glass-inset-*, закрывшая себя сама. */
.probe-global {
  margin-top: 0;
}
`,
      );
    },
    command: gateCommand('cascade-comment-broken-in-css'),
    teardown() {
      cleanup('cascade-comment-broken-in-css');
    },
  },

  {
    id: 'cascade-media-overridden-in-astro',
    gate: 'check:cascade-order',
    describe:
      'Медиазапрос перебит ПОЗЖЕ в том же файле правилом той же специфичности — ' +
      'то есть не работает ни на одной ширине. Эта ловушка срабатывала в проекте ' +
      'четырежды и каждый раз находилась человеком глазами, а не инструментом.',
    greenRun: GREEN,
    expectOutputContains: 'КЛАСС 2: медиазапрос перебит поздним правилом верхнего уровня',
    setup() {
      layout(
        'cascade-media-overridden-in-astro',
        `<div class="probe">проба</div>

<style>
  @media (max-width: 859px) {
    .probe {
      justify-content: center;
    }
  }

  /* Базовое правило НИЖЕ медиазапроса при равной специфичности: побеждает оно,
     и центрирование не применяется никогда. */
  .probe {
    justify-content: flex-start;
  }
</style>
`,
        ZDOROVYJ_CSS,
      );
    },
    command: gateCommand('cascade-media-overridden-in-astro'),
    teardown() {
      cleanup('cascade-media-overridden-in-astro');
    },
  },

  {
    id: 'cascade-media-overridden-by-shorthand',
    gate: 'check:cascade-order',
    describe:
      'Тот же класс, но перебивает СОКРАЩЁНКА: `margin` ниже медиазапроса гасит ' +
      'объявленный в нём `margin-top`. Именно так умерли `.hero-h1{margin-bottom}` ' +
      'и `.hero-stats{margin-top:auto}` — совпадения имён свойств тут нет, и случай ' +
      'на прямом имени эту половину не доказал бы.',
    greenRun: GREEN,
    expectOutputContains: 'КЛАСС 2: медиазапрос перебит поздним правилом верхнего уровня',
    setup() {
      layout(
        'cascade-media-overridden-by-shorthand',
        ZDOROVYJ_ASTRO,
        `@media (max-width: 859px) {
  .probe-global {
    margin-top: auto;
  }
}

/* Сокращёнка ниже медиазапроса: перекрывает margin-top, объявленный выше. */
.probe-global {
  margin: 0;
}
`,
      );
    },
    command: gateCommand('cascade-media-overridden-by-shorthand'),
    teardown() {
      cleanup('cascade-media-overridden-by-shorthand');
    },
  },
];
