/**
 * Сценарии заварки целиком: настоящий service-worker.js на моке Chrome-API.
 * Здесь ловятся вещи, которые не видит юнит-тест движка, — дубли объявлений,
 * потерянные ответы и залипшие кнопки.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installChromeMock } from './helpers/chrome-mock.mjs'

const catalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/tea.json', import.meta.url)), 'utf8'))
const shou = catalog.find(t => t.key === 'shou_puer')

/** Свежий воркер на каждый сценарий: модуль кешируется, поэтому ?n=. */
let n = 0
async function boot() {
  const env = installChromeMock()
  await import(`../src/background/service-worker.js?n=${++n}`)
  return env
}

const start = (env, tea = shou, grams = 7, volume = 100) =>
  env.toWorker({ type: 'start', tea, grams, volume })

/** Промотать текущий шаг: время вышло, документ сообщает воркеру. */
function expire(env) {
  const s = env.session()
  s.endTime = Date.now() - 1
  env.store.set('session', s)
  return env.toWorker({ type: 'expired' })
}

test('новая сессия ждёт старта и сама не бежит', async () => {
  const env = await boot()
  const s = await start(env)
  assert.equal(s.status, 'await')
  assert.equal(s.idx, 0)
  assert.equal(env.played.gong.length, 0)
})

test('«Старт» запускает отсчёт и отвечает попапу состоянием', async () => {
  const env = await boot()
  await start(env)
  const s = await env.toWorker({ type: 'start-step' })
  assert.ok(s, 'воркер обязан ответить, иначе попап решит, что сессии нет')
  assert.equal(s.status, 'running')
  assert.ok(s.endTime > Date.now())
  assert.equal(env.session().status, 'running')
})

test('конец шага объявляется ровно один раз', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'start-step' })
  await expire(env)

  assert.equal(env.played.gong.length, 1, 'гонг прозвучал не один раз')
  assert.equal(env.played.clip.length, 1, 'фраза прозвучала не один раз')
  assert.equal(env.notifications.length, 1)
  assert.equal(env.session().status, 'await')
  assert.equal(env.session().idx, 1)
})

test('повторные сигналы о том же шаге ничего не переигрывают', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'start-step' })
  await expire(env)

  // Ровно то, что происходит в жизни: документ, попап и аларм разом.
  await env.toWorker({ type: 'expired' })
  await env.toWorker({ type: 'sync' })
  await env.fireAlarm('tea-keepalive')

  assert.equal(env.played.gong.length, 1)
  assert.equal(env.played.clip.length, 1)
})

test('одновременные сигналы не удваивают объявление', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'start-step' })

  const s = env.session()
  s.endTime = Date.now() - 1
  env.store.set('session', s)

  // Три источника узнали об окончании шага в один и тот же момент.
  await Promise.all([
    env.toWorker({ type: 'expired' }),
    env.toWorker({ type: 'sync' }),
    env.toWorker({ type: 'expired' }),
  ])

  assert.equal(env.played.gong.length, 1, 'гонг продублировался')
  assert.equal(env.played.clip.length, 1, 'фраза продублировалась')
})

test('фраза озвучивается клипом, а не системным синтезом', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'start-step' })
  await expire(env)

  assert.equal(env.played.clip.length, 1)
  assert.match(env.played.clip[0].clip, /src\/assets\/voices\/dmitry\/[0-9a-f]+\.mp3$/)
  // Английский голос русскую фразу читать не должен.
  assert.deepEqual(env.played.tts, [])
})

test('вся сессия проходится шаг за шагом, каждый — по кнопке', async () => {
  const env = await boot()
  const s0 = await start(env)
  const total = s0.steps.length

  for (let i = 0; i < total; i++) {
    const started = await env.toWorker({ type: 'start-step' })
    assert.equal(started.status, 'running', `шаг ${i} не запустился`)
    assert.equal(started.idx, i)
    await expire(env)
  }

  const done = env.session()
  assert.equal(done.status, 'done')
  assert.equal(env.played.gong.length, total, 'на каждый шаг ровно один гонг')
  assert.equal(done.doneSteeps, s0.steps.filter(s => !s.rinse).length)
})

test('«Пропустить» переводит к следующему шагу без отсчёта и без звука', async () => {
  const env = await boot()
  await start(env)
  const s = await env.toWorker({ type: 'skip' })
  assert.equal(s.idx, 1)
  assert.equal(s.status, 'await')
  assert.equal(env.played.gong.length, 0)
})

test('пауза и продолжение сохраняют остаток', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'start-step' })
  const paused = await env.toWorker({ type: 'pause' })
  assert.equal(paused.status, 'paused')
  assert.ok(paused.leftMs > 0)
  const resumed = await env.toWorker({ type: 'resume' })
  assert.equal(resumed.status, 'running')
})

test('остановка стирает сессию', async () => {
  const env = await boot()
  await start(env)
  await env.toWorker({ type: 'stop' })
  assert.equal(env.session(), undefined)
})

test('неизвестное сообщение не роняет воркер', async () => {
  const env = await boot()
  await start(env)
  assert.equal(await env.toWorker({ type: 'что-то-новое' }), null)
  assert.ok(env.session(), 'сессия должна пережить непонятное сообщение')
})

test('западная заварка тоже идёт по шагам', async () => {
  const env = await boot()
  const s = await start(env, shou, 8, 500)
  assert.equal(s.mode, 'western')
  const started = await env.toWorker({ type: 'start-step' })
  assert.equal(started.status, 'running')
  await expire(env)
  assert.equal(env.played.clip.length, 1)
})
