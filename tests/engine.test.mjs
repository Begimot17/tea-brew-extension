import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createSession, tick, pause, resume, startStep, skip, shift, nextWakeAt, currentStep, leftMs,
} from '../src/lib/engine.js'
import { teaPhrase, teaNotificationTitle, PACK_CLASSIC, PACK_NEUTRAL, PACK_SUNBOY } from '../src/lib/phrases.js'

const catalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/tea.json', import.meta.url)), 'utf8'))
const shou = catalog.find(t => t.key === 'shou_puer')
const CFG = {}

const fresh = () => createSession(shou, 7, 100, 1)

// ── запуск только по кнопке ──────────────────────────────────────────────────

test('сессия ждёт старта, а не бежит сама', () => {
  const s = fresh()
  assert.equal(s.status, 'await')
  assert.equal(s.idx, 0)
  assert.equal(nextWakeAt(s), null)
  // На часах — длительность предстоящего шага.
  assert.equal(leftMs(s), s.steps[0].sec * 1000)
})

test('«Старт» запускает шаг, на котором стоим', () => {
  const s = fresh()
  const t0 = 1_000_000
  const r = startStep(s, t0)
  assert.equal(r.status, 'running')
  assert.equal(r.idx, 0)
  assert.equal(r.endTime, t0 + s.steps[0].sec * 1000)
  assert.equal(nextWakeAt(r), r.endTime)
})

test('пока шаг не запущен, время не идёт', () => {
  const s = fresh()
  const { session, events } = tick(s, CFG, s.startedAt + 3_600_000)
  assert.equal(session.status, 'await')
  assert.deepEqual(events, [])
})

test('конец шага объявляется и сессия встаёт перед следующим', () => {
  const s = startStep(fresh(), 1000)
  const { session, events } = tick(s, CFG, s.endTime + 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'rinse')     // у шу пуэра первыми идут промывки
  assert.equal(events[0].stepIndex, 0)
  assert.equal(session.status, 'await')
  assert.equal(session.idx, 1)              // стоим перед следующим шагом
  assert.equal(nextWakeAt(session), null)
})

test('tick идемпотентна: повторный вызов не плодит событий', () => {
  const s = startStep(fresh(), 1000)
  const first = tick(s, CFG, s.endTime + 1)
  const again = tick(first.session, CFG, s.endTime + 10_000)
  assert.deepEqual(again.events, [])
  assert.equal(again.session.status, 'await')
  assert.equal(again.session.idx, first.session.idx)
})

test('сон воркера не проматывает сессию дальше одного шага', () => {
  const s = startStep(fresh(), 1000)
  const { session, events } = tick(s, CFG, s.endTime + 3_600_000)
  assert.equal(events.length, 1)
  assert.equal(session.idx, 1)
  assert.equal(session.status, 'await')
})

test('последний шаг завершает сессию', () => {
  const s = fresh()
  const lastIdx = s.steps.length - 1
  const at = startStep({ ...s, idx: lastIdx }, 1000)
  const { session, events } = tick(at, CFG, at.endTime + 1)
  assert.equal(session.status, 'done')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(nextWakeAt(session), null)
})

test('промывки не считаются проливами', () => {
  let s = fresh()
  for (let i = 0; i < shou.rinses; i++) s = tick(startStep(s, 1000), CFG, 10_000_000).session
  assert.equal(s.doneSteeps, 0)
  s = tick(startStep(s, 1000), CFG, 10_000_000).session
  assert.equal(s.doneSteeps, 1)
})

// ── управление ───────────────────────────────────────────────────────────────

test('пауза сохраняет остаток, возобновление его возвращает', () => {
  const s = startStep(fresh(), 1000)
  const at = s.endTime - 3000
  const p = pause(s, at)
  assert.equal(p.status, 'paused')
  assert.equal(p.leftMs, 3000)
  assert.equal(nextWakeAt(p), null)
  const r = resume(p, at + 60_000)
  assert.equal(r.status, 'running')
  assert.equal(r.endTime, at + 63_000)
})

test('«Пропустить» встаёт перед следующим шагом, не запуская его', () => {
  const s = startStep(fresh(), 1000)
  const n = skip(s)
  assert.equal(n.idx, 1)
  assert.equal(n.status, 'await')
  assert.equal(nextWakeAt(n), null)
  const last = skip({ ...s, idx: s.steps.length - 1 })
  assert.equal(last.status, 'done')
})

test('±секунды: в ожидании правят длительность шага, на ходу — остаток', () => {
  const s = fresh()
  const longer = shift(s, 5)
  assert.equal(currentStep(longer).sec, s.steps[0].sec + 5)
  assert.equal(longer.steps[1].sec, s.steps[1].sec, 'соседние шаги не трогаем')
  assert.ok(shift(s, -600).steps[0].sec >= 3, 'шаг не схлопывается в ноль')

  const run = startStep(s, 1000)
  assert.equal(shift(run, 5, 1000).endTime, run.endTime + 5000)
  const p = pause(run, run.endTime - 10_000)
  assert.equal(shift(p, -5).leftMs, 5000)
  assert.equal(shift(p, -600).leftMs, 1000)
})

// ── фразы ────────────────────────────────────────────────────────────────────

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
