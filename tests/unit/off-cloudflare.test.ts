
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFF_CLOUDFLARE_PATHS,
  isOffCloudflareNoise,
  unexpectedConsoleErrors,
  type ConsoleErrorItem,
} from '../../scripts/lib/off-cloudflare.ts';

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

function item(description: string, url: string): ConsoleErrorItem {
  return { source: 'network', description, sourceLocation: { url } };
}

test('оба известных адреса объявлены и ни одного лишнего', () => {
  assert.deepEqual([...OFF_CLOUDFLARE_PATHS], ['/cdn-cgi/trace', '/api/lead']);
});

test('404 по точке Cloudflare и по Pages Function — шум среды', () => {
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/cdn-cgi/trace'), true);
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://127.0.0.1:53211/cdn-cgi/trace'), true);
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/api/lead'), true);
});

test('404 по НАШЕМУ ресурсу шумом среды не считается', () => {

  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/_astro/index.CxYz.js'), false);
  assert.equal(
    isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/fonts/manrope-subset.woff2'),
    false,
  );
  assert.equal(
    isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/_astro/ub-square.avif'),
    false,
  );
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/'), false);
});

test('НЕ сетевая ошибка на том же адресе шумом среды не считается', () => {

  assert.equal(
    isOffCloudflareNoise(
      'Uncaught (in promise) TypeError: text.split is not a function',
      'http://localhost:4321/cdn-cgi/trace',
    ),
    false,
  );
});

test('похожий, но чужой адрес не проходит: сверка по концу пути, а не по вхождению', () => {
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://localhost:4321/cdn-cgi/trace-log'), false);
  assert.equal(isOffCloudflareNoise(NOT_FOUND, 'http://evil.example/api/lead?x=1'), false);
});

test('unexpectedConsoleErrors пропускает шум и оставляет чужое', () => {
  const items = [
    item(NOT_FOUND, 'http://localhost:4321/cdn-cgi/trace'),
    item(NOT_FOUND, 'http://localhost:4321/api/lead'),
    item(NOT_FOUND, 'http://localhost:4321/_astro/interactive.js'),
    item('Uncaught TypeError: dialog.showModal is not a function', 'http://localhost:4321/'),
  ];
  const left = unexpectedConsoleErrors(items);
  assert.equal(left.length, 2, 'два элемента обязаны остаться и уронить прогон');
  assert.deepEqual(
    left.map((i) => i.sourceLocation?.url),
    ['http://localhost:4321/_astro/interactive.js', 'http://localhost:4321/'],
  );
});

test('чистый прогон даёт пустой список, и отбор не выдумывает элементов', () => {
  assert.deepEqual(unexpectedConsoleErrors([]), []);
  assert.deepEqual(unexpectedConsoleErrors([item(NOT_FOUND, 'http://x/cdn-cgi/trace')]), []);
});

test('элемент без адреса и без текста остаётся замеченным', () => {

  assert.equal(unexpectedConsoleErrors([{}]).length, 1);
  assert.equal(unexpectedConsoleErrors([{ description: NOT_FOUND }]).length, 1);
});
