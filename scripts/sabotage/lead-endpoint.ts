
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { portFree } from '../lib/preflight.ts';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-lead-endpoint.ts'],
  costly:
    'поднимает настоящий рантайм Workers (wrangler pages dev, порт 8788) и ходит в живой siteverify — 22 с и сеть',
};

const STUB_SOURCE = [
  "import('node:http').then(function (http) {",
  '  var server = http.createServer(function (req, res) {',
  '    req.on("data", function () {});',
  '    req.on("end", function () {',
  '      res.writeHead(200, { "content-type": "application/json" });',
  '      res.end(JSON.stringify({ ok: true }));',
  '    });',
  '  });',
  '  server.listen(0, "127.0.0.1", function () {',
  '    process.stdout.write("PORT " + server.address().port + "\\n");',
  '  });',
  '});',
].join('\n');

let stub: ChildProcess | undefined;
let stubPort = 0;

function killStub(): void {
  if (stub?.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(stub.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  stub.kill('SIGKILL');
}

const alwaysOk: SabotageCase = {
  id: 'lead-endpoint-always-200',
  gate: 'check:lead-endpoint',
  describe:
    'вместо настоящего рантайма — заглушка, отвечающая 200 и {"ok":true} на любой запрос',
  async setup() {
    stub = spawn(process.execPath, ['-e', STUB_SOURCE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    stubPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('заглушка не сообщила порт за 10 с')), 10_000);
      let out = '';
      stub?.stdout?.setEncoding('utf8');
      stub?.stdout?.on('data', (chunk: string) => {
        out += chunk;
        const match = /PORT (\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      stub?.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`заглушка завершилась с кодом ${String(code)} до готовности`));
      });
    });
  },
  get command() {
    return [
      '--experimental-strip-types',
      'scripts/check-lead-endpoint.ts',
      '--base',
      `http://127.0.0.1:${stubPort}`,
    ];
  },
  expectOutputContains: 'ОЖИДАЛСЯ 429',
  greenRun: GREEN,
  async teardown() {
    killStub();
    stub = undefined;
    if (stubPort === 0) return;

    const deadline = Date.now() + 10_000;
    while (!(await portFree(stubPort))) {
      if (Date.now() >= deadline) {
        throw new Error(`порт заглушки ${stubPort} не освободился за 10 с`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stubPort = 0;
  },
};

export const cases: SabotageCase[] = [alwaysOk];
