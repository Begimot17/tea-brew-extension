import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildSteps, steepCount, strengthRatio, waterRatio, recommendedGrams,
  brewMode, modeInfo, totalSec, plural, MODE_THRESHOLD,
} from '../src/lib/brew.js'

const catalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/tea.json', import.meta.url)), 'utf8'))
const tea = k => catalog.find(t => t.key === k)
const pours = (t, g, v) => buildSteps(t, g, v).filter(s => !s.rinse)

test('каталог на месте', () => {
  assert.ok(catalog.length >= 18)
  assert.ok(tea('shou_puer'))
})

// ── режимы ───────────────────────────────────────────────────────────────────

test('режим определяется соотношением воды к листу', () => {
  const t = tea('shou_puer')
  assert.equal(brewMode(t, 7, 100), 'gongfu')      // 1:14 — классическое гунфу
  assert.equal(brewMode(t, 5, 100), 'gongfu')      // 1:20
  assert.equal(brewMode(t, 8, 500), 'western')     // 1:63 — чайник
  assert.equal(brewMode(t, 2.5, 250), 'western')   // 1:100 — кружка
})

test('пакетик и травы гунфу не заваривают ни при каком соотношении', () => {
  for (const key of ['tea_bag', 'chamomile', 'black_tea']) {
    assert.equal(brewMode(tea(key), 10, 100), 'western')
    assert.equal(brewMode(tea(key), 1, 500), 'western')
  }
})

test('соотношение считается как мл на грамм', () => {
  assert.equal(Math.round(waterRatio(8, 500)), 63)
  assert.equal(Math.round(waterRatio(7, 100)), 14)
})

// ── случай, с которого начался пересчёт ──────────────────────────────────────

test('8 г пуэра на 500 мл — это чайник: три настоя по минутам, а не десяток проливов', () => {
  const t = tea('shou_puer')
  const p = pours(t, 8, 500)
  assert.equal(brewMode(t, 8, 500), 'western')
  assert.ok(p.length <= 3, `настоев ${p.length}, ожидали не больше трёх`)
  // Первый настой — минуты, а не секунды, но и не десять минут.
  assert.ok(p[0].sec >= 120 && p[0].sec <= 300, `первый настой ${p[0].sec} с`)
  assert.ok(p.every(s => s.sec <= 360))
})

// ── гунфу ────────────────────────────────────────────────────────────────────

test('эталонная навеска воспроизводит каталог один-в-один', () => {
  const t = tea('shou_puer')
  const g = recommendedGrams(t, 100)
  assert.equal(strengthRatio(t, g, 100), 1)
  assert.equal(brewMode(t, g, 100), 'gongfu')
  assert.deepEqual(pours(t, g, 100).map(s => s.sec), t.steeps_sec)
})

test('в гунфу плотнее навеска — больше проливов и они короче', () => {
  const t = tea('shou_puer')
  const base = pours(t, 7, 100)
  const strong = pours(t, 12, 100)
  assert.ok(strong.length > base.length)
  assert.ok(strong[0].sec < base[0].sec)
})

test('гунфу-пролив не превращается в многоминутный настой', () => {
  for (const t of catalog.filter(x => x.style !== 'western')) {
    for (const g of [4, 5, 6, 7, 10, 14]) {
      const p = pours(t, g, 100)
      assert.ok(p.every(s => s.sec <= 240), `${t.key} ${g}г: ${p.map(s => s.sec)}`)
      assert.ok(p.length >= 4, `${t.key} ${g}г: проливов ${p.length}`)
    }
  }
})

test('промывки идут первыми и в нужном количестве', () => {
  const t = tea('shou_puer')
  const steps = buildSteps(t, 7, 100)
  assert.equal(steps.filter(s => s.rinse).length, t.rinses)
  assert.ok(steps.slice(0, t.rinses).every(s => s.rinse))
})

// ── западная заварка ─────────────────────────────────────────────────────────

test('стандартная кружка 2.5 г на 250 мл даёт настои в 2–6 минут', () => {
  for (const key of ['shou_puer', 'green', 'dianhong', 'tieguanyin', 'white']) {
    const p = pours(tea(key), 2.5, 250)
    assert.ok(p.length >= 1 && p.length <= 3, `${key}: ${p.length} настоев`)
    assert.ok(p[0].sec >= 120 && p[0].sec <= 360, `${key}: первый настой ${p[0].sec} с`)
  }
})

test('зелёный настаивают меньше пуэра при одинаковой посуде', () => {
  assert.ok(pours(tea('green'), 2.5, 250)[0].sec < pours(tea('shou_puer'), 2.5, 250)[0].sec)
})

test('меньше листа на ту же воду — настой длиннее', () => {
  const t = tea('shou_puer')
  assert.ok(pours(t, 2, 500)[0].sec > pours(t, 5, 500)[0].sec)
})

test('каждый следующий настой дольше предыдущего', () => {
  const p = pours(tea('shou_puer'), 8, 500)
  for (let i = 1; i < p.length; i++) assert.ok(p[i].sec > p[i - 1].sec)
})

test('прессованный чай промывают и в чайнике, лист без прессовки — нет', () => {
  assert.ok(buildSteps(tea('shou_puer'), 8, 500).some(s => s.rinse))
  assert.ok(!buildSteps(tea('green'), 2.5, 250).some(s => s.rinse))
})

test('бытовые сорта берут тайминги прямо из каталога', () => {
  const t = tea('chamomile')
  assert.deepEqual(pours(t, 2, 250).map(s => s.sec), t.steeps_sec)
})

// ── общее ────────────────────────────────────────────────────────────────────

test('на границе режимов расчёт не ломается и не даёт абсурда', () => {
  const t = tea('shou_puer')
  for (const ratio of [MODE_THRESHOLD - 1, MODE_THRESHOLD, MODE_THRESHOLD + 1]) {
    const p = pours(t, 100 / ratio, 100)
    assert.ok(p.length >= 1)
    assert.ok(p.every(s => s.sec >= 3 && s.sec <= 480))
  }
})

test('все сорта каталога считаются без сбоев на любой посуде', () => {
  for (const t of catalog) {
    for (const v of [60, 100, 250, 500]) {
      for (const g of [1, 2, 5, recommendedGrams(t, v)]) {
        const steps = buildSteps(t, g, v)
        assert.ok(steps.length > 0, `${t.key} ${g}/${v}`)
        assert.ok(steps.every(s => Number.isFinite(s.sec) && s.sec >= 3 && s.sec <= 600),
          `${t.key} ${g}г/${v}мл: ${steps.map(s => s.sec)}`)
      }
    }
  }
})

test('modeInfo даёт название режима, соотношение и слово для счёта', () => {
  const g = modeInfo(tea('shou_puer'), 7, 100)
  assert.equal(g.mode, 'gongfu')
  assert.equal(g.ratio, 14)
  assert.equal(g.word[2], 'проливов')
  const w = modeInfo(tea('shou_puer'), 8, 500)
  assert.equal(w.mode, 'western')
  assert.equal(w.word[2], 'настоев')
})

test('steepCount совпадает с числом непромывочных шагов', () => {
  const t = tea('shou_puer')
  assert.equal(steepCount(t, 7, 100), pours(t, 7, 100).length)
  assert.equal(steepCount(t, 8, 500), pours(t, 8, 500).length)
})

test('общая длительность — сумма шагов', () => {
  const steps = buildSteps(tea('shou_puer'), 7, 100)
  assert.equal(totalSec(steps), steps.reduce((s, x) => s + x.sec, 0))
})

test('склонение проливов', () => {
  const f = ['пролив', 'пролива', 'проливов']
  assert.equal(plural(1, f), 'пролив')
  assert.equal(plural(3, f), 'пролива')
  assert.equal(plural(11, f), 'проливов')
  assert.equal(plural(21, f), 'пролив')
})
