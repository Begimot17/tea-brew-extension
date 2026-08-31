import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildSteps, steepCount, strengthRatio, recommendedGrams, pourSec, totalSec, plural,
} from '../src/lib/brew.js'

const catalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/tea.json', import.meta.url)), 'utf8'))
const tea = k => catalog.find(t => t.key === k)

test('каталог на месте', () => {
  assert.ok(catalog.length >= 18)
  assert.ok(tea('shou_puer'))
})

test('эталонная навеска воспроизводит каталог один-в-один', () => {
  const t = tea('shou_puer')
  const g = recommendedGrams(t, 100)
  assert.equal(strengthRatio(t, g, 100), 1)
  assert.equal(steepCount(t, g, 100), t.steeps_sec.length)
  const steeps = buildSteps(t, g, 100).filter(s => !s.rinse).map(s => s.sec)
  assert.deepEqual(steeps, t.steeps_sec)
})

test('крепость зависит от отношения г/мл, а не от абсолютных чисел', () => {
  const t = tea('shou_puer')
  assert.equal(strengthRatio(t, 7, 200), strengthRatio(t, 3.5, 100))
  assert.equal(steepCount(t, 14, 200), steepCount(t, 7, 100))
})

test('больше листа — проливов больше и они короче', () => {
  const t = tea('shou_puer')
  const base = buildSteps(t, 7, 100).filter(s => !s.rinse)
  const strong = buildSteps(t, 14, 100).filter(s => !s.rinse)
  const weak = buildSteps(t, 3.5, 100).filter(s => !s.rinse)
  assert.ok(strong.length > base.length)
  assert.ok(weak.length < base.length)
  assert.ok(strong[0].sec < base[0].sec)
  assert.ok(weak[0].sec > base[0].sec)
})

test('число проливов монотонно по навеске и не выходит за границы', () => {
  const t = tea('sheng_puer')
  const baseN = t.steeps_sec.length
  let prev = 0
  for (const g of [1, 2, 3, 4, 6, 8, 10, 14, 20, 30]) {
    const n = steepCount(t, g, 100)
    assert.ok(n >= prev, `n не должно падать при росте навески (${g} г)`)
    assert.ok(n >= 3 && n <= baseN + 4, `n=${n} вне границ`)
    prev = n
  }
})

test('западная заварка число настоев не масштабирует', () => {
  const t = tea('tea_bag')
  const baseN = t.steeps_sec.length
  assert.equal(steepCount(t, 1, 250), baseN)
  assert.equal(steepCount(t, 20, 250), baseN)
})

test('промывки идут первыми и в нужном количестве', () => {
  const t = tea('shou_puer')
  const steps = buildSteps(t, 7, 100)
  assert.equal(steps.filter(s => s.rinse).length, t.rinses)
  assert.ok(steps.slice(0, t.rinses).every(s => s.rinse))
  assert.ok(steps.every(s => s.sec >= 3))
})

test('пауза на пролив растёт с объёмом и остаётся в границах', () => {
  assert.ok(pourSec(60) <= pourSec(200))
  assert.ok(pourSec(200) <= pourSec(500))
  assert.ok(pourSec(10) >= 6 && pourSec(5000) <= 20)
})

test('общая длительность учитывает паузы между шагами', () => {
  const t = tea('shou_puer')
  const steps = buildSteps(t, 7, 100)
  const bare = steps.reduce((s, x) => s + x.sec, 0)
  assert.equal(totalSec(steps, 100), bare + pourSec(100) * (steps.length - 1))
})

test('все сорта каталога считаются без сбоев', () => {
  for (const t of catalog) {
    for (const v of [60, 100, 250, 500]) {
      const steps = buildSteps(t, recommendedGrams(t, v), v)
      assert.ok(steps.length > 0, t.key)
      assert.ok(steps.every(s => Number.isFinite(s.sec) && s.sec >= 3), t.key)
    }
  }
})

test('склонение проливов', () => {
  const f = ['пролив', 'пролива', 'проливов']
  assert.equal(plural(1, f), 'пролив')
  assert.equal(plural(3, f), 'пролива')
  assert.equal(plural(11, f), 'проливов')
  assert.equal(plural(21, f), 'пролив')
})
