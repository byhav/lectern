'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Activity = {
  id: string
  title: string
  is_active: boolean
}

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'waiting' }
  | { status: 'active'; activity: Activity }

const CHAR_LIMIT = 500
const NEAR_LIMIT = 50

export default function ParticipantPage() {
  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showSlowWarning, setShowSlowWarning] = useState(false)
  const lastSubmitRef = useRef<number>(0)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function fetchActiveActivity() {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      setState({ status: 'error', message: 'Failed to load activity.' })
      return
    }
    setState(data ? { status: 'active', activity: data } : { status: 'waiting' })
  }

  useEffect(() => {
    fetchActiveActivity()

    const channel = supabase
      .channel('participant-activities')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'activities' },
        () => {
          fetchActiveActivity()
          setSubmitted(false)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

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
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
        <div className="text-center max-w-sm w-full">
          <div className="w-20 h-20 rounded-full bg-lectern-teal flex items-center justify-center mx-auto mb-6">
            <span className="text-white text-3xl font-bold">✓</span>
          </div>
          <h2 className="text-3xl font-bold text-lectern-slate mb-2">Response received</h2>
          <p className="text-lectern-slate/60 mb-8 text-lg">Thanks for contributing.</p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setSubmitted(false)}
              className="w-full py-4 bg-lectern-coral text-white font-bold rounded-xl text-lg hover:opacity-90 transition-opacity"
            >
              Submit another response
            </button>
            <Link
              href="/wall"
              className="w-full py-4 border-2 border-lectern-sage text-lectern-sage font-semibold rounded-xl text-lg text-center hover:bg-lectern-sage/10 transition-colors"
            >
              View the wall →
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const charsLeft = CHAR_LIMIT - input.length
  const nearLimit = charsLeft <= NEAR_LIMIT

  return (
    <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <h1 className="text-4xl font-bold text-lectern-slate mb-8 leading-tight">
          {state.activity.title}
        </h1>

        {showSlowWarning && (
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
            <button
              onClick={handleSubmit}
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
      </div>
    </div>
  )
}
