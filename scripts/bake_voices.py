"""Запекает фразы уведомлений в аудиофайлы, чтобы озвучка жила внутри проекта.

Системный синтез не годится: русского голоса в системе может не быть вовсе
(на машине разработки стоял только английский Microsoft Zira), и тогда
расширение просто молчит. Поэтому все фразы синтезируются заранее и лежат
рядом с кодом — расширению остаётся проиграть готовый файл.

Каждым голосом печётся полный набор фраз всех паков: голос выбирается в
настройках отдельно для каждого набора, и любая комбинация должна звучать.

Пак «Пророк Санбой» сюда не входит: его фразы записаны отдельным пайплайном
(f5tts+rvc) и уже лежат в src/assets/voices/sunboy с манифестом того же вида.

Запуск (нужен интернет — синтез идёт на стороне Microsoft Edge TTS):
    python -m pip install edge-tts
    python scripts/bake_voices.py

Повторный запуск досинтезирует только новые фразы.
"""

import asyncio
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHRASES_JS = (ROOT / 'src' / 'lib' / 'phrases.js').resolve().as_uri()
PACKS = ['classic', 'neutral', 'sunboy']

# id голоса → голос Edge TTS. id попадает в путь к файлам и в настройки.
VOICES = {
    'dmitry': 'ru-RU-DmitryNeural',
    'svetlana': 'ru-RU-SvetlanaNeural',
}

DECOR = re.compile(r'[\U0001F000-\U0001FAFF←-⇿⌀-➿️‍⬀-⯿]')


def normalize(text: str) -> str:
    """Ключ клипа. Обязан совпадать с normalize() в src/lib/voice.js."""
    t = DECOR.sub(' ', text or '')
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'[.!?…]+$', '', t).strip()
    return t.lower()


def spoken(text: str) -> str:
    """Что произносить: без эмодзи, но с обычной пунктуацией."""
    t = DECOR.sub(' ', text or '')
    return re.sub(r'\s+', ' ', t).strip()


def collect() -> list[str]:
    """Все фразы всех паков — прямо из phrases.js, чтобы списки не расходились."""
    script = f'''
      import {{ teaPhrase }} from '{PHRASES_JS}'
      const packs = {json.dumps(PACKS)}
      const keys = [null, 'shou_puer', 'sheng_puer', 'dahongpao', 'tieguanyin', 'milk_oolong',
        'gaba_oolong', 'dianhong', 'green', 'white', 'heicha', 'black_tea', 'tea_bag',
        'chamomile', 'mint', 'hibiscus', 'rooibos', 'ivan_chai', 'kuqiao']
      const out = new Set()
      // Фразы выбираются детерминированно по (seed, шаг), поэтому обходим сетку
      // значений — так вытаскивается весь пул, включая редкие варианты.
      for (const pack of packs)
        for (const teaKey of keys)
          for (const kind of ['steep', 'rinse', 'finish'])
            for (let seed = 0; seed < 12; seed++)
              for (let i = 0; i < 24; i++)
                out.add(teaPhrase(kind, i, seed, undefined, {{ pack, teaKey }}))
      console.log(JSON.stringify([...out]))
    '''
    tmp = ROOT / '.bake-collect.mjs'
    tmp.write_text(script, encoding='utf-8')
    try:
        res = subprocess.run(['node', str(tmp)], capture_output=True, text=True, encoding='utf-8')
        if res.returncode:
            sys.exit(f'не удалось собрать фразы:\n{res.stderr}')
        return json.loads(res.stdout)
    finally:
        tmp.unlink(missing_ok=True)


async def bake(voice_id: str, edge_voice: str, phrases: list[str]) -> None:
    import edge_tts

    out_dir = ROOT / 'src' / 'assets' / 'voices' / voice_id
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / 'src' / 'data' / f'voices-{voice_id}.json'

    clips: dict[str, str] = {}
    if manifest_path.exists():
        clips = json.loads(manifest_path.read_text(encoding='utf-8')).get('clips', {})

    print(f'\n{voice_id} ({edge_voice}): {len(phrases)} фраз')
    for i, phrase in enumerate(phrases, 1):
        key = normalize(phrase)
        text = spoken(phrase)
        if not key or not text:
            continue
        name = hashlib.sha1(key.encode('utf-8')).hexdigest()[:12] + '.mp3'
        target = out_dir / name
        if clips.get(key) == name and target.exists():
            continue
        await edge_tts.Communicate(text, edge_voice).save(str(target))
        clips[key] = name
        print(f'  [{i}/{len(phrases)}] {text}')

    # Файлы, на которые больше никто не ссылается, в репозитории не нужны.
    used = set(clips.values())
    for f in out_dir.glob('*.mp3'):
        if f.name not in used:
            f.unlink()

    manifest_path.write_text(json.dumps(
        {'meta': {'voice': voice_id, 'engine': 'edge-tts', 'source': edge_voice}, 'clips': clips},
        ensure_ascii=False, indent=1), encoding='utf-8')
    size = sum(f.stat().st_size for f in out_dir.glob('*.mp3')) // 1024
    print(f'{voice_id}: {len(clips)} клипов, {size} КБ')


async def main() -> None:
    phrases = collect()
    for voice_id, edge_voice in VOICES.items():
        await bake(voice_id, edge_voice, phrases)


if __name__ == '__main__':
    asyncio.run(main())
