import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSession, tick, pause, resume, next, shift, nextWakeAt } from '../src/lib/engine.js'
import { teaPhrase, teaNotificationTitle, PACK_CLASSIC, PACK_NEUTRAL, PACK_SUNBOY } from '../src/lib/phrases.js'

const catalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/tea.json', import.meta.url)), 'utf8'))
const shou = catalog.find(t => t.key === 'shou_puer')
const CFG = { autoAdvance: true, gapSec: 0 }

test('сессия стартует с первого шага', () => {
  const s = createSession(shou, 7, 100, 1)
  assert.equal(s.idx, 0)
  assert.equal(s.status, 'running')
  assert.equal(nextWakeAt(s), s.endTime)
})

test('шаг завершается событием и уходит в паузу на пролив', () => {
  const s = createSession(shou, 7, 100, 1)
  const { session, events } = tick(s, CFG, s.endTime + 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'rinse')     // у шу пуэра первыми идут промывки
  assert.equal(session.status, 'gap')
  assert.equal(session.idx, 1)
})

test('без автоперехода сессия ждёт пользователя', () => {
  const s = createSession(shou, 7, 100, 1)
  const { session } = tick(s, { ...CFG, autoAdvance: false }, s.endTime + 1)
  assert.equal(session.status, 'await')
  assert.equal(nextWakeAt(session), null)
})

test('долгий сон воркера отрабатывает все пропущенные фазы разом', () => {
  const s = createSession(shou, 7, 100, 1)
  const { session, events } = tick(s, CFG, s.startedAt + 3_600_000)
  assert.equal(session.status, 'done')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.length, s.steps.length)
  assert.equal(session.doneSteeps, s.steps.filter(x => !x.rinse).length)
})

test('tick идемпотентна: повторный вызов не плодит событий', () => {
  const s = createSession(shou, 7, 100, 1)
  const first = tick(s, CFG, s.endTime + 1)
  const again = tick(first.session, CFG, s.endTime + 1)
  assert.equal(again.events.length, 0)
  assert.equal(again.session.status, first.session.status)
})

test('пауза сохраняет остаток, возобновление его возвращает', () => {
  const s = createSession(shou, 7, 100, 1)
  const at = s.endTime - 3000
  const p = pause(s, at)
  assert.equal(p.status, 'paused')
  assert.equal(p.leftMs, 3000)
  assert.equal(nextWakeAt(p), null)
  const r = resume(p, at + 60_000)
  assert.equal(r.status, 'running')
  assert.equal(r.endTime, at + 63_000)
})

test('«дальше» перескакивает на следующий шаг, на последнем завершает', () => {
  const s = createSession(shou, 7, 100, 1)
  const n = next(s, CFG, s.startedAt)
  assert.equal(n.idx, 1)
  assert.equal(n.endTime, s.startedAt + s.steps[1].sec * 1000)
  const last = next({ ...s, idx: s.steps.length - 1 }, CFG, s.startedAt)
  assert.equal(last.status, 'done')
})

test('±секунды двигают конец фазы и остаток на паузе', () => {
  const s = createSession(shou, 7, 100, 1)
  assert.equal(shift(s, 5, s.startedAt).endTime, s.endTime + 5000)
  const p = pause(s, s.endTime - 10_000)
  assert.equal(shift(p, -5).leftMs, 5000)
  // Ниже секунды не опускаемся, иначе шаг схлопнется в ноль.
  assert.equal(shift(p, -600).leftMs, 1000)
})

test('фразы детерминированы и зависят от пака', () => {
  const a = teaPhrase('steep', 3, 42, undefined, { pack: PACK_CLASSIC, teaKey: 'shou_puer' })
  const b = teaPhrase('steep', 3, 42, undefined, { pack: PACK_CLASSIC, teaKey: 'shou_puer' })
  assert.equal(a, b)
  assert.equal(teaPhrase('steep', 3, 42, undefined, { pack: PACK_NEUTRAL }), 'Чай готов')
  assert.equal(teaNotificationTitle(PACK_SUNBOY), '🍵 Так предсказано')
  assert.equal(teaNotificationTitle(PACK_CLASSIC), '🍵 Чай готов')
})

test('дефолтный пак — старые чайные фразы, пророк только у sunboy', () => {
  const classic = new Set()
  const prophet = new Set()
  for (let i = 0; i < 40; i++) {
    classic.add(teaPhrase('steep', i, 7, undefined, { teaKey: 'shou_puer' }))
    prophet.add(teaPhrase('steep', i, 7, undefined, { pack: PACK_SUNBOY, teaKey: 'shou_puer' }))
  }
  assert.ok([...classic].some(p => p.includes('пуэрчик')))
  assert.ok(![...classic].some(p => p.includes('предсказано')))
  assert.ok([...prophet].some(p => p.includes('предсказано')))
})

test('без имени фраза не содержит плейсхолдера', () => {
  for (let i = 0; i < 60; i++)
    for (const pack of [PACK_CLASSIC, PACK_SUNBOY])
      for (const kind of ['steep', 'rinse', 'finish'])
        assert.ok(!teaPhrase(kind, i, 5, undefined, { pack, teaKey: 'shou_puer' }).includes('{name}'))
})

// У видов чая свои фразы без обращения, поэтому имя ищем там, где оно вообще
// встречается: в общих пулах промывки и завершения.
test('имя подставляется', () => {
  const found = Array.from({ length: 60 }, (_, i) =>
    teaPhrase('finish', i, 3, 'Никита', { teaKey: 'green' }))
  assert.ok(found.some(p => p.includes('Никита')))
  assert.ok(!found.some(p => p.includes('{name}')))
})
