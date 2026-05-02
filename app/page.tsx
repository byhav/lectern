'use client'

import { useEffect, useState } from 'react'
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

export default function ParticipantPage() {
  const [state, setState] = useState<PageState>({ status: 'loading' })
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

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
    if (state.status !== 'active' || !input.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    const { error } = await supabase
      .from('responses')
      .insert({ activity_id: state.activity.id, content: input.trim() })
    setSubmitting(false)
    if (error) {
      setSubmitError('Failed to submit. Please try again.')
      return
    }
    setSubmitted(true)
    setInput('')
  }

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500">{state.message}</p>
      </div>
    )
  }

  if (state.status === 'waiting') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-semibold text-zinc-700">Waiting for an activity...</p>
          <p className="text-zinc-400 mt-2">Check back soon.</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-semibold text-zinc-700">Thanks for your response!</p>
          <button
            onClick={() => setSubmitted(false)}
            className="mt-6 px-6 py-2 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 transition-colors"
          >
            Submit another response
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <h1 className="text-3xl font-bold text-zinc-900 mb-8">{state.activity.title}</h1>
        {submitError && (
          <p className="text-red-500 text-sm mb-4">{submitError}</p>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your response..."
          rows={4}
          className="w-full border border-zinc-300 rounded-lg px-4 py-3 text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 resize-none"
        />
        <button
          onClick={handleSubmit}
          disabled={submitting || !input.trim()}
          className="mt-4 w-full py-3 bg-zinc-800 text-white font-medium rounded-lg hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
      </div>
    </div>
  )
}
