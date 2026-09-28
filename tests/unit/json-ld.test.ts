
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonLd } from '../../src/lib/json-ld.ts';

test('`</script>` в тексте словаря не закрывает тег, а смысл не меняется', () => {
  const value = { '@type': 'Answer', text: 'ответ </script><b>x</b> <!-- и комментарий' };
  const out = jsonLd(value);
  assert.equal(out.includes('</'), false, 'в выводе осталось `</`');
  assert.equal(out.includes('<!--'), false, 'в выводе осталось `<!--`');
  assert.deepEqual(JSON.parse(out), value, 'разборщик JSON прочёл не тот текст');
});

test('текст без `<` проходит без изменений', () => {
  const value = { name: 'MELBET түншийн хөтөлбөр', n: 3 };
  assert.equal(jsonLd(value), JSON.stringify(value));
});
