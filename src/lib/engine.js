/**
 * Машина состояний заварки — чистые функции над объектом сессии.
 * Одна реализация на попап и на фоновый воркер: попап только рисует,
 * переходы считает движок.
 *
 * session = {
 *   teaKey, teaName, style, seed, grams, volume,
 *   steps: [{ label, sec, rinse }],
 *   idx,                    // индекс текущего шага
 *   status: 'running' | 'gap' | 'await' | 'paused' | 'done',
 *   endTime,                // ms epoch конца текущей фазы (running | gap)
 *   leftMs,                 // остаток при паузе
 *   startedAt, doneSteeps
 * }
 */

import { buildSteps, pourSec } from './brew.js'

export function createSession(tea, grams, volume, seed) {
  const steps = buildSteps(tea, grams, volume)
  return {
    teaKey: tea.key, teaName: tea.name, style: tea.style || null,
    seed, grams, volume, steps,
    idx: 0, status: 'running',
    endTime: Date.now() + steps[0].sec * 1000,
    leftMs: 0, startedAt: Date.now(), doneSteeps: 0,
  }
}

export function gapMs(session, settings) {
  const sec = settings.gapSec > 0 ? settings.gapSec : pourSec(session.volume)
  return sec * 1000
}

export function leftMs(session, now = Date.now()) {
  if (session.status === 'paused') return session.leftMs
  if (session.status === 'await' || session.status === 'done') return 0
  return Math.max(0, session.endTime - now)
}

/**
 * Продвинуть сессию, если текущая фаза истекла.
 * Возвращает { session, events } — events для звука и уведомлений.
 * Идемпотентна: вызывать можно хоть каждую секунду.
 */
export function tick(session, settings, now = Date.now()) {
  const events = []
  let s = { ...session }

  // Цикл на случай, если воркер спал и истекло сразу несколько фаз.
  for (let guard = 0; guard < 64; guard++) {
    if (s.status === 'paused' || s.status === 'await' || s.status === 'done') break
    if (now < s.endTime) break

    if (s.status === 'gap') {
      // Пауза «залей кипяток» кончилась — пошёл следующий пролив.
      s = { ...s, status: 'running', endTime: s.endTime + s.steps[s.idx].sec * 1000 }
      continue
    }

    // Шаг доварился.
    const step = s.steps[s.idx]
    const last = s.idx >= s.steps.length - 1
    events.push({
      type: last ? 'finish' : (step.rinse ? 'rinse' : 'steep'),
      stepIndex: s.idx,
      label: step.label,
    })
    const doneSteeps = s.doneSteeps + (step.rinse ? 0 : 1)

    if (last) {
      s = { ...s, status: 'done', doneSteeps, leftMs: 0 }
      break
    }
    if (!settings.autoAdvance) {
      s = { ...s, status: 'await', doneSteeps, leftMs: 0 }
      break
    }
    s = { ...s, status: 'gap', doneSteeps, idx: s.idx + 1, endTime: s.endTime + gapMs(s, settings) }
  }

  return { session: s, events }
}

export function pause(session, now = Date.now()) {
  if (session.status !== 'running' && session.status !== 'gap') return session
  return { ...session, status: 'paused', leftMs: Math.max(0, session.endTime - now), prev: session.status }
}

export function resume(session, now = Date.now()) {
  if (session.status !== 'paused') return session
  const { prev, ...rest } = session
  return { ...rest, status: prev || 'running', endTime: now + (session.leftMs || 0), leftMs: 0 }
}

/** Ручной переход к следующему шагу (кнопка «Дальше» и режим без автоперехода). */
export function next(session, settings, now = Date.now()) {
  if (session.status === 'done') return session
  const last = session.idx >= session.steps.length - 1
  if (last) return { ...session, status: 'done', leftMs: 0 }
  const idx = session.idx + 1
  return { ...session, idx, status: 'running', endTime: now + session.steps[idx].sec * 1000, leftMs: 0 }
}

/** ±секунды к текущей фазе. */
export function shift(session, sec, now = Date.now()) {
  if (session.status === 'paused')
    return { ...session, leftMs: Math.max(1000, session.leftMs + sec * 1000) }
  if (session.status !== 'running' && session.status !== 'gap') return session
  return { ...session, endTime: Math.max(now + 1000, session.endTime + sec * 1000) }
}

/** Момент, когда воркеру нужно проснуться; null — таймер не идёт. */
export function nextWakeAt(session) {
  if (!session) return null
  if (session.status === 'running' || session.status === 'gap') return session.endTime
  return null
}
