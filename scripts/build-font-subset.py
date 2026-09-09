#!/usr/bin/env python3
"""
scripts/build-font-subset.py — сборка self-hosted сабсета шрифта (Фаза 2.2).

Запускается вручную ОДИН раз на обновление шрифта; результат (woff2) коммитится
в public/fonts/. В рантайме и в CI не участвует — CI проверяет уже готовый файл
через scripts/check-font-coverage.ts.

Почему Python, а не Node: единственный зрелый сабсеттер woff2 — fontTools
(pyftsubset). Это прямо зафиксировано в tech-stack проекта (CLAUDE.md,
"Development Tools": `pyftsubset` (fonttools) для монгольского сабсета).

    python -m pip install fonttools brotli
    python scripts/build-font-subset.py

⚠️ Почему нельзя взять готовый "cyrillic"-сабсет с Google Fonts: проверено
эмпирически на файлах шрифтов (см. 02.2-UI-SPEC.md §2) — Unbounded и
Wix Madefor вообще не содержат Ө (U+04E8) и Ү (U+04AE), хотя формально
объявляют кириллицу. Здесь сабсет строится по явному списку кодпоинтов, а
покрытие проверяется гейтом, а не на глаз.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.request
from pathlib import Path

try:
    from fontTools.subset import Subsetter, Options
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ImportError:
    sys.exit("Нет fontTools. Установить: python -m pip install fonttools brotli")

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "fonts"

# Manrope — единственная гарнитура проекта. Переменная ось wght 200-800, одна
# ось (в отличие от 4-осевых кандидатов) => сабсет остаётся лёгким. Покрытие
# Ө/ө/Ү/ү/₮ подтверждено замером cmap, а не обещанием провайдера. OFL.
SOURCE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/manrope/Manrope%5Bwght%5D.ttf"
FAMILY = "Manrope"
OUT_NAME = "manrope-subset.woff2"

# Диапазоны кодпоинтов. Держим ЦЕЛЫЙ блок кириллицы, а не только буквы,
# встречающиеся в текущих i18n-строках: поля формы принимают произвольный
# пользовательский ввод, и подстановка системного шрифта на одну букву внутри
# инпута читается как брак.
UNICODE_RANGES: list[tuple[int, int]] = [
    (0x0020, 0x007E),  # базовая латиница
    (0x00A0, 0x00A0),  # неразрывный пробел
    (0x00AB, 0x00AB),  # «
    (0x00BB, 0x00BB),  # »
    (0x00B0, 0x00B0),  # °
    (0x00B7, 0x00B7),  # · разделитель в строке статуса; нашёл гейт покрытия
    (0x00A9, 0x00A9),  # ©
    (0x00AE, 0x00AE),  # ®
    (0x0400, 0x04FF),  # кириллица целиком: русский + монгольские Ө/ө/Ү/ү
    (0x2010, 0x2015),  # дефисы и тире (в ru/mn длинное тире — норма пунктуации)
    (0x2018, 0x201F),  # типографские кавычки
    (0x2022, 0x2022),  # •
    (0x2026, 0x2026),  # …
    (0x2039, 0x203A),  # ‹ ›
    (0x2116, 0x2116),  # №
    (0x20AE, 0x20AE),  # ₮ тугрик
    (0x20AC, 0x20AC),  # €
    (0x2190, 0x2193),  # ← ↑ → ↓ — стрелка → реально встречается в копирайте
                       #   всех трёх локалей; нашёл гейт check-font-coverage.ts
    (0x2212, 0x2212),  # минус
]

# Символы, без которых страница считается сломанной. Дублируются в
# scripts/check-font-coverage.ts — там это гейт, здесь ранняя остановка сборки.
CRITICAL = {
    0x04E8: "Ө", 0x04E9: "ө", 0x04AE: "Ү", 0x04AF: "ү",
    0x20AE: "₮", 0x0401: "Ё", 0x0451: "ё", 0x2116: "№",
}


def codepoints() -> set[int]:
    out: set[int] = set()
    for lo, hi in UNICODE_RANGES:
        out.update(range(lo, hi + 1))
    return out


def main() -> None:
    print(f"Скачиваю {FAMILY} ...")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "LandingMN/1.0"})
    raw = urllib.request.urlopen(req, timeout=180).read()
    print(f"  исходник: {len(raw) // 1024} КБ")

    font = TTFont(io.BytesIO(raw))

    have: set[int] = set()
    for table in font["cmap"].tables:
        have |= set(table.cmap.keys())
    missing = {cp: ch for cp, ch in CRITICAL.items() if cp not in have}
    if missing:
        sys.exit(
            "Исходный шрифт не содержит обязательных символов: "
            + ", ".join(f"{ch} (U+{cp:04X})" for cp, ch in missing.items())
        )
    print(f"  все {len(CRITICAL)} обязательных символа на месте")

    wanted = codepoints() & have
    print(f"  оставляю {len(wanted)} из {len(have)} символов")

    options = Options()
    # flavor НЕ выставляем здесь: при woff2-флейворе на этапе сабсеттинга
    # fontTools отдаёт 60 КБ вместо 26 (замерено). Флейвор ставится на
    # объекте шрифта уже перед save() — ниже.
    options.desubroutinize = False
    options.hinting = True
    options.layout_features = ["*"]   # kern/liga/locl нужны кириллице
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.retain_gids = False

    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)

    # Сначала сабсет, только потом сужение оси. Обратный порядок роняет
    # fontTools на ленивом gvar (KeyError 'space') — проверено.
    #
    # Ось режется до 400-800: начертания легче 400 на тёмном фоне
    # нечитаемы, а дельты для них всё равно занимают место в файле.
    # Одна переменная гарнитура (25,6 КБ) против двух статических
    # начертаний 400+700 (29,8 КБ и два запроса) — замерено на этом же
    # наборе символов.
    font = instancer.instantiateVariableFont(
        font, {"wght": (400, 400, 800)}, updateFontNames=False
    )
    font.flavor = "woff2"

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / OUT_NAME
    font.save(str(out_path))
    font.close()

    payload = out_path.read_bytes()
    size = len(payload)

    # Манифест покрытия: гейт в CI (scripts/check-font-coverage.ts) сверяет по
    # нему каждый символ из всех трёх i18n-словарей. sha256 привязывает
    # манифест к конкретному файлу — разойтись молча они не могут.
    manifest = {
        "family": FAMILY,
        "file": OUT_NAME,
        "bytes": size,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "axes": {"wght": [400, 800]},
        "codepoints": sorted(wanted),
        "source": SOURCE_URL,
        "license": "OFL-1.1",
    }
    manifest_path = OUT_DIR / (OUT_NAME.replace(".woff2", "") + ".coverage.json")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"OK  {out_path.relative_to(ROOT)} — {size / 1024:.1f} КБ")
    print(f"OK  {manifest_path.relative_to(ROOT)} — {len(wanted)} символов")


if __name__ == "__main__":
    main()
