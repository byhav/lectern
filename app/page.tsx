'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Activity = {
  id: string
  title: string
  is_active: boolean
  type: 'text' | 'rating' | 'wordcloud' | 'sequence'
  options: { choices: string[] } | { prompts: [string, string, string] } | null
}

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'waiting' }
  | { status: 'active'; activity: Activity }

// 0–2 = which prompt to show, 3 = all done
type SequenceStep = 0 | 1 | 2 | 3

const CHAR_LIMIT = 500
const NEAR_LIMIT = 50
const WORDCLOUD_CHAR_LIMIT = 50

function getOrCreateParticipantId(): { id: string; storageUnavailable: boolean } {
  try {
    let id = localStorage.getItem('lectern_participant_id')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('lectern_participant_id', id)
    }
    return { id, storageUnavailable: false }
  } catch {
    return { id: crypto.randomUUID(), storageUnavailable: true }
  }
}

export default function ParticipantPage() {
  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showSlowWarning, setShowSlowWarning] = useState(false)

  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [sequenceStep, setSequenceStep] = useState<SequenceStep>(0)
  const [sequenceLoading, setSequenceLoading] = useState(false)
  const [sequenceTransitioning, setSequenceTransitioning] = useState(false)

  const lastSubmitRef = useRef<number>(0)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const participantIdRef = useRef<string | null>(null)

  // Initialize participant ID synchronously so it's available before the activity fetch effect runs
  useEffect(() => {
    const { id, storageUnavailable: unavailable } = getOrCreateParticipantId()
    participantIdRef.current = id
    setStorageUnavailable(unavailable)
  }, [])

  async function fetchSequenceStep(activityId: string, pid: string) {
    setSequenceLoading(true)
    const { data, error } = await supabase
      .from('responses')
      .select('id')
      .eq('activity_id', activityId)
      .eq('participant_id', pid)

    if (!error && data) {
      setSequenceStep(Math.min(data.length, 3) as SequenceStep)
    }
    setSequenceLoading(false)
  }

  async function fetchActiveActivity(): Promise<Activity | null> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      setState({ status: 'error', message: 'Failed to load activity.' })
      return null
    }
    setState(data ? { status: 'active', activity: data } : { status: 'waiting' })
    return data
  }

  useEffect(() => {
    async function init() {
      const act = await fetchActiveActivity()
      if (act?.type === 'sequence' && participantIdRef.current) {
        await fetchSequenceStep(act.id, participantIdRef.current)
      }
    }
    init()

    const channel = supabase
      .channel('participant-activities')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'activities' },
        async () => {
          setSubmitted(false)
          setInput('')
          setSubmitError(null)
          setSequenceTransitioning(false)
          if (transitionTimerRef.current) {
            clearTimeout(transitionTimerRef.current)
            transitionTimerRef.current = null
          }

          const act = await fetchActiveActivity()
          if (act?.type === 'sequence' && participantIdRef.current) {
            await fetchSequenceStep(act.id, participantIdRef.current)
          } else {
            setSequenceStep(0)
            setSequenceLoading(false)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current)
    }
  }, [])

  async function handleRatingSubmit(choice: string) {
    if (state.status !== 'active') return
    if (Date.now() - lastSubmitRef.current < 2000) return
    lastSubmitRef.current = Date.now()

    setSubmitting(true)
    setSubmitError(null)

    try {
      const { error } = await supabase
        .from('responses')
        .insert({ activity_id: state.activity.id, content: choice })
      if (error) throw error
      setSubmitted(true)
    } catch {
      setSubmitError('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleWordcloudSubmit() {
    if (state.status !== 'active' || !input.trim() || input.length > WORDCLOUD_CHAR_LIMIT) return
    if (Date.now() - lastSubmitRef.current < 2000) return
    lastSubmitRef.current = Date.now()

    setSubmitting(true)
    setSubmitError(null)

    try {
      const { error } = await supabase
        .from('responses')
        .insert({ activity_id: state.activity.id, content: input.trim() })
      if (error) throw error
      setSubmitted(true)
      setInput('')
    } catch {
      setSubmitError('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit() {
    if (state.status !== 'active' || !input.trim() || input.length > CHAR_LIMIT) return
    if (Date.now() - lastSubmitRef.current < 2000) return
    lastSubmitRef.current = Date.now()

    setSubmitting(true)
    setSubmitError(null)
    setShowSlowWarning(false)

    slowTimerRef.current = setTimeout(() => setShowSlowWarning(true), 5000)

    try {
      const { error } = await supabase
        .from('responses')
        .insert({ activity_id: state.activity.id, content: input.trim() })

      if (error) throw error

      setSubmitted(true)
      setInput('')
    } catch {
      setSubmitError('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }
      setShowSlowWarning(false)
    }
  }

  async function handleSequenceSubmit() {
    if (state.status !== 'active' || state.activity.type !== 'sequence') return
    if (sequenceStep >= 3 || !input.trim() || input.length > CHAR_LIMIT) return
    if (!participantIdRef.current) return
    if (Date.now() - lastSubmitRef.current < 2000) return
    lastSubmitRef.current = Date.now()

    setSubmitting(true)
    setSubmitError(null)

    try {
      const { error } = await supabase
        .from('responses')
        .insert({
          activity_id: state.activity.id,
          content: input.trim(),
          participant_id: participantIdRef.current,
        })
      if (error) throw error

      const nextStep = (sequenceStep + 1) as SequenceStep
      setInput('')

      if (nextStep >= 3) {
        setSequenceStep(3)
      } else {
        setSequenceTransitioning(true)
        if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = setTimeout(() => {
          setSequenceTransitioning(false)
          setSequenceStep(nextStep)
          transitionTimerRef.current = null
        }, 1200)
      }
    } catch {
      setSubmitError('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center">
        <p className="text-lectern-slate/50">Loading…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
        <p className="text-lectern-coral font-medium">{state.message}</p>
      </div>
    )
  }

  if (state.status === 'waiting') {
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-2xl font-semibold text-lectern-slate">Waiting for an activity…</p>
          <p className="text-lectern-slate/60 mt-2 text-lg">Check back soon.</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    const isWordcloudSubmit = state.activity.type === 'wordcloud'
    const isRatingSubmit = state.activity.type === 'rating'
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
        <div className="text-center max-w-sm w-full">
          <div className="w-20 h-20 rounded-full bg-lectern-teal flex items-center justify-center mx-auto mb-6">
            <span className="text-white text-3xl font-bold">✓</span>
          </div>
          <h2 className="text-3xl font-bold text-lectern-slate mb-2">
            {isWordcloudSubmit ? 'Got it.' : 'Response received'}
          </h2>
          <p className="text-lectern-slate/60 mb-8 text-lg">
            {isWordcloudSubmit ? 'Add another word to the cloud.' : 'Thanks for contributing.'}
          </p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setSubmitted(false)}
              className="w-full py-4 bg-lectern-coral text-white font-bold rounded-xl text-lg hover:opacity-90 transition-opacity"
            >
              {isWordcloudSubmit ? 'Add another word' : 'Submit another response'}
            </button>
            <Link
              href="/wall"
              className="w-full py-4 border-2 border-lectern-sage text-lectern-sage font-semibold rounded-xl text-lg text-center hover:bg-lectern-sage/10 transition-colors"
            >
              {isRatingSubmit ? 'View results →' : isWordcloudSubmit ? 'View the word cloud →' : 'View the wall →'}
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isRating = state.activity.type === 'rating'
  const isWordcloud = state.activity.type === 'wordcloud'
  const isSequence = state.activity.type === 'sequence'
  const choices = (state.activity.options as { choices?: string[] })?.choices ?? ['low', 'medium', 'high']
  const CHOICE_COLORS = ['bg-lectern-teal', 'bg-lectern-sand', 'bg-lectern-coral']

  const charsLeft = CHAR_LIMIT - input.length
  const nearLimit = charsLeft <= NEAR_LIMIT
  const wordCount = input.trim() ? input.trim().split(/\s+/).length : 0

  const prompts = (state.activity.options as { prompts?: [string, string, string] })?.prompts ?? ['', '', '']

  return (
    <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
      <div className="w-full max-w-lg">

        {isSequence ? (
          <>
            {storageUnavailable && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6">
                <p className="text-amber-700 text-sm">
                  Your browser doesn&apos;t support saving progress. Don&apos;t refresh until you&apos;ve finished all three prompts.
                </p>
              </div>
            )}

            {sequenceLoading ? (
              <p className="text-lectern-slate/50 text-center">Loading…</p>
            ) : sequenceStep >= 3 ? (
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-lectern-teal flex items-center justify-center mx-auto mb-6">
                  <span className="text-white text-3xl font-bold">✓</span>
                </div>
                <h2 className="text-3xl font-bold text-lectern-slate mb-2">All done. Thank you.</h2>
                <div className="mt-6 flex flex-col items-center gap-3">
                  <Link
                    href="/wall"
                    className="inline-block w-full py-4 px-8 border-2 border-lectern-sage text-lectern-sage font-semibold rounded-xl text-lg text-center hover:bg-lectern-sage/10 transition-colors"
                  >
                    View the wall →
                  </Link>
                  <button
                    onClick={() => { setSequenceStep(0); setInput('') }}
                    className="w-full py-4 px-8 border-2 border-lectern-slate/20 text-lectern-slate/60 font-semibold rounded-xl text-lg hover:bg-lectern-slate/5 transition-colors"
                  >
                    Submit another
                  </button>
                </div>
              </div>
            ) : sequenceTransitioning ? (
              <div className="text-center py-8">
                <p className="text-2xl font-semibold text-lectern-slate/60">Got it. Next:</p>
              </div>
            ) : (
              <>
                <p className="text-2xl font-semibold text-lectern-slate/70 mb-4">
                  {([
                    'What is one important thing you learned regarding AI at this conference?',
                    'How does it change the way you think about integrating AI into your practices?',
                    'What are your next steps to integrate this change?',
                  ] as const)[sequenceStep as 0 | 1 | 2]}
                </p>
                <h1 className="text-4xl font-bold text-lectern-slate mb-8 leading-tight">
                  {prompts[sequenceStep as 0 | 1 | 2]}
                </h1>

                {submitError && (
                  <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
                    <p className="text-lectern-coral font-medium text-sm">{submitError}</p>
                    <button
                      onClick={handleSequenceSubmit}
                      disabled={submitting}
                      className="shrink-0 text-sm font-semibold text-lectern-coral border border-lectern-coral rounded-lg px-3 py-1 hover:bg-lectern-coral hover:text-white transition-colors disabled:opacity-40"
                    >
                      Retry
                    </button>
                  </div>
                )}

                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSequenceSubmit()
                  }}
                  placeholder="Type your response…"
                  rows={5}
                  maxLength={CHAR_LIMIT}
                  className="w-full border-2 border-lectern-slate/20 rounded-xl px-4 py-3 text-lectern-slate placeholder-lectern-slate/40 focus:outline-none focus:border-lectern-coral bg-white/70 resize-none text-lg"
                />
                <div className="flex justify-end mt-1 mb-4">
                  <span className={`text-xs tabular-nums ${nearLimit && input.length > 0 ? 'text-lectern-coral font-medium' : 'text-lectern-slate/40'}`}>
                    {input.length}/{CHAR_LIMIT}
                  </span>
                </div>
                <button
                  onClick={handleSequenceSubmit}
                  disabled={submitting || !input.trim() || input.length > CHAR_LIMIT}
                  className="w-full py-4 bg-lectern-coral text-white font-bold rounded-xl text-xl hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                >
                  {submitting ? 'Submitting…' : 'Submit'}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <h1 className="text-4xl font-bold text-lectern-slate mb-8 leading-tight">
              {state.activity.title}
            </h1>

            {!isRating && !isWordcloud && showSlowWarning && (
              <div className="flex items-start justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
                <p className="text-amber-700 text-sm">
                  Slow connection. Switching to your phone&apos;s data may help.
                </p>
                <button
                  onClick={() => setShowSlowWarning(false)}
                  className="text-amber-400 hover:text-amber-600 text-lg leading-none shrink-0"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}

            {submitError && (
              <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
                <p className="text-lectern-coral font-medium text-sm">{submitError}</p>
                {!isRating && (
                  <button
                    onClick={isWordcloud ? handleWordcloudSubmit : handleSubmit}
                    disabled={submitting}
                    className="shrink-0 text-sm font-semibold text-lectern-coral border border-lectern-coral rounded-lg px-3 py-1 hover:bg-lectern-coral hover:text-white transition-colors disabled:opacity-40"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {isRating ? (
              <div className="flex flex-col gap-4">
                {choices.map((choice, i) => (
                  <button
                    key={choice}
                    onClick={() => handleRatingSubmit(choice)}
                    disabled={submitting}
                    className={`w-full py-5 ${CHOICE_COLORS[i % CHOICE_COLORS.length]} text-lectern-slate font-bold rounded-xl text-2xl hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity capitalize`}
                  >
                    {choice}
                  </button>
                ))}
                <Link
                  href="/wall"
                  className="mt-2 block text-center text-lectern-slate/50 hover:text-lectern-slate transition-colors text-sm"
                >
                  View results →
                </Link>
              </div>
            ) : isWordcloud ? (
              <>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleWordcloudSubmit() }}
                  placeholder="One word or short phrase…"
                  maxLength={WORDCLOUD_CHAR_LIMIT}
                  autoComplete="off"
                  className="w-full border-2 border-lectern-slate/20 rounded-xl px-4 py-3 text-lectern-slate placeholder-lectern-slate/40 focus:outline-none focus:border-lectern-coral bg-white/70 text-lg"
                />
                <div className="flex items-start justify-between mt-1 mb-4 min-h-[1.25rem]">
                  <span className="text-xs text-amber-600">
                    {wordCount > 3 ? 'Tip: shorter responses make better word clouds.' : ''}
                  </span>
                  <span className="text-xs text-lectern-slate/40 tabular-nums shrink-0">
                    {input.trim() ? `${wordCount} ${wordCount === 1 ? 'word' : 'words'}` : ''}
                  </span>
                </div>
                <button
                  onClick={handleWordcloudSubmit}
                  disabled={submitting || !input.trim()}
                  className="w-full py-4 bg-lectern-coral text-white font-bold rounded-xl text-xl hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                >
                  {submitting ? 'Submitting…' : 'Submit'}
                </button>
                <Link
                  href="/wall"
                  className="mt-5 block text-center text-lectern-slate/50 hover:text-lectern-slate transition-colors text-sm"
                >
                  View the wall →
                </Link>
              </>
            ) : (
              <>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
                  }}
                  placeholder="Type your response…"
                  rows={5}
                  maxLength={CHAR_LIMIT}
                  className="w-full border-2 border-lectern-slate/20 rounded-xl px-4 py-3 text-lectern-slate placeholder-lectern-slate/40 focus:outline-none focus:border-lectern-coral bg-white/70 resize-none text-lg"
                />
                <div className="flex justify-end mt-1 mb-4">
                  <span className={`text-xs tabular-nums ${nearLimit ? 'text-lectern-coral font-medium' : 'text-lectern-slate/40'}`}>
                    {input.length}/{CHAR_LIMIT}
                  </span>
                </div>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !input.trim() || input.length > CHAR_LIMIT}
                  className="w-full py-4 bg-lectern-coral text-white font-bold rounded-xl text-xl hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                >
                  {submitting ? 'Submitting…' : 'Submit'}
                </button>
                <Link
                  href="/wall"
                  className="mt-5 block text-center text-lectern-slate/50 hover:text-lectern-slate transition-colors text-sm"
                >
                  View the wall →
                </Link>
              </>
            )}
          </>
        )}

      </div>
    </div>
  )
}
