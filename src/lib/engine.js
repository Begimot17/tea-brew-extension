/**
 * Машина состояний заварки — чистые функции над объектом сессии.
 * Одна реализация на попап и на фоновый воркер: попап только рисует,
 * переходы считает движок.
 *
 * session = {
 *   teaKey, teaName, style, mode, seed, grams, volume,
 *   steps: [{ label, sec, rinse }],
 *   idx,                    // индекс текущего шага
 *   status: 'running' | 'await' | 'paused' | 'done',
 *   endTime,                // ms epoch конца текущего шага
 *   leftMs,                 // остаток при паузе
 *   startedAt, doneSteeps
 * }
 */

import { buildSteps, brewMode } from './brew.js'

export function createSession(tea, grams, volume, seed) {
  const steps = buildSteps(tea, grams, volume)
  return {
    teaKey: tea.key, teaName: tea.name, style: tea.style || null,
    mode: brewMode(tea, grams, volume),
    seed, grams, volume, steps,
    idx: 0, status: 'running',
    endTime: Date.now() + steps[0].sec * 1000,
    leftMs: 0, startedAt: Date.now(), doneSteeps: 0,
  }
}

export function leftMs(session, now = Date.now()) {
  if (session.status === 'paused') return session.leftMs
  if (session.status === 'await' || session.status === 'done') return 0
  return Math.max(0, session.endTime - now)
}

/**
 * Продвинуть сессию, если текущий шаг истёк.
 * Возвращает { session, events } — events для звука и уведомлений.
 * Идемпотентна: вызывать можно хоть каждую секунду.
 */
export function tick(session, _settings, now = Date.now()) {
  let s = { ...session }
  if (s.status !== 'running' || now < s.endTime) return { session: s, events: [] }

  // Шаг доварился. Сам таймер дальше не идёт: следующий пролив запускает
  // пользователь, когда реально заварит — сколько он льёт и пьёт, мы не знаем.
  const step = s.steps[s.idx]
  const last = s.idx >= s.steps.length - 1
  const events = [{
    type: last ? 'finish' : (step.rinse ? 'rinse' : 'steep'),
    stepIndex: s.idx,
    label: step.label,
  }]
  const doneSteeps = s.doneSteeps + (step.rinse ? 0 : 1)

  s = { ...s, status: last ? 'done' : 'await', doneSteeps, leftMs: 0 }
  return { session: s, events }
}

export function pause(session, now = Date.now()) {
  if (session.status !== 'running') return session
  return { ...session, status: 'paused', leftMs: Math.max(0, session.endTime - now), prev: session.status }
}

export function resume(session, now = Date.now()) {
  if (session.status !== 'paused') return session
  const { prev, ...rest } = session
  return { ...rest, status: prev || 'running', endTime: now + (session.leftMs || 0), leftMs: 0 }
}

/** Запустить следующий шаг — кнопка «Следующий пролив». */
export function next(session, now = Date.now()) {
  if (session.status === 'done') return session
  const last = session.idx >= session.steps.length - 1
  if (last) return { ...session, status: 'done', leftMs: 0 }
  const idx = session.idx + 1
  return { ...session, idx, status: 'running', endTime: now + session.steps[idx].sec * 1000, leftMs: 0 }
}

/** ±секунды к текущему шагу. */
export function shift(session, sec, now = Date.now()) {
  if (session.status === 'paused')
    return { ...session, leftMs: Math.max(1000, session.leftMs + sec * 1000) }
  if (session.status !== 'running') return session
  return { ...session, endTime: Math.max(now + 1000, session.endTime + sec * 1000) }
}

/** Момент, когда воркеру нужно проснуться; null — таймер не идёт. */
export function nextWakeAt(session) {
  if (!session) return null
  if (session.status === 'running') return session.endTime
  return null
}
