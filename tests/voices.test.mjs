/**
 * Озвучка должна жить внутри проекта: в системе может не быть ни одного
 * русского голоса, и тогда всё, что не записано заранее, просто молчит.
 * Тест ловит ситуацию «добавили фразу, а запечь забыли».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { teaPhrase, PACK_CLASSIC, PACK_NEUTRAL, PACK_SUNBOY } from '../src/lib/phrases.js'

const root = new URL('../', import.meta.url)
const read = rel => JSON.parse(readFileSync(fileURLToPath(new URL(rel, root)), 'utf8'))

// Та же нормализация, что в src/lib/voice.js и scripts/bake_voices.py.
const DECOR = /[\p{Extended_Pictographic}‍️]/gu
const normalize = t => (t || '')
  .replace(DECOR, ' ').replace(/\s+/g, ' ').trim()
  .replace(/[.!?…]+$/, '').trim().toLowerCase()

const TEA_KEYS = [null, 'shou_puer', 'sheng_puer', 'dahongpao', 'tieguanyin', 'milk_oolong',
  'gaba_oolong', 'dianhong', 'green', 'white', 'heicha', 'black_tea', 'tea_bag',
  'chamomile', 'mint', 'hibiscus', 'rooibos', 'ivan_chai', 'kuqiao']

/** Все фразы пака: выбор детерминирован, поэтому обходим сетку (seed, шаг). */
function allPhrases(pack) {
  const out = new Set()
  for (const teaKey of TEA_KEYS)
    for (const kind of ['steep', 'rinse', 'finish'])
      for (let seed = 0; seed < 12; seed++)
        for (let i = 0; i < 24; i++)
          out.add(teaPhrase(kind, i, seed, undefined, { pack, teaKey }))
  return [...out]
}

const VOICES = ['dmitry', 'svetlana', 'sunboy']

test('манифест каждого голоса ссылается на существующие файлы', () => {
  for (const voice of VOICES) {
    const { clips } = read(`src/data/voices-${voice}.json`)
    assert.ok(Object.keys(clips).length > 0, `${voice}: пустой манифест`)
    for (const [phrase, file] of Object.entries(clips)) {
      const path = fileURLToPath(new URL(`src/assets/voices/${voice}/${file}`, root))
      assert.ok(existsSync(path), `${voice}: нет файла ${file} для «${phrase}»`)
    }
  }
})

test('ключи манифестов уже нормализованы', () => {
  for (const voice of VOICES) {
    const { clips } = read(`src/data/voices-${voice}.json`)
    for (const key of Object.keys(clips))
      assert.equal(key, normalize(key), `${voice}: ключ «${key}» не нормализован`)
  }
})

test('нейроголоса озвучивают все фразы всех наборов', () => {
  for (const voice of ['dmitry', 'svetlana']) {
    const { clips } = read(`src/data/voices-${voice}.json`)
    for (const pack of [PACK_CLASSIC, PACK_NEUTRAL, PACK_SUNBOY]) {
      const missing = allPhrases(pack).filter(p => !clips[normalize(p)])
      assert.deepEqual(missing, [], `${voice} не знает фраз пака ${pack}`)
    }
  }
})

test('у Пророка записаны все его собственные фразы', () => {
  const { clips } = read('src/data/voices-sunboy.json')
  const missing = allPhrases(PACK_SUNBOY).filter(p => !clips[normalize(p)])
  assert.deepEqual(missing, [], 'Пророку нечем сказать эти фразы')
})

test('эмодзи не попадают в ключи — иначе клип не найдётся', () => {
  const withEmoji = allPhrases(PACK_CLASSIC).find(p => DECOR.test(p))
  assert.ok(withEmoji, 'в классическом наборе ожидались фразы с эмодзи')
  assert.ok(!DECOR.test(normalize(withEmoji)))
})
