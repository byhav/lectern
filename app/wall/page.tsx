'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Activity = {
  id: string
  title: string
  is_active: boolean
}

type Response = {
  id: string
  created_at: string
  activity_id: string
  content: string
}

const NOTE_BG = [
  'rgb(255 211 91 / 0.4)',   // sand  #ffd35b  40%
  'rgb(168 232 249 / 1)',    // teal  #a8e8f9  100%
  'rgb(245 162 1 / 0.4)',    // orange #f5a201 40%
  'rgb(168 232 249 / 0.4)',  // teal  #a8e8f9  30%
]

function noteBg(index: number): string {
  return NOTE_BG[index % 4]
}

export default function WallPage() {
  const [lastActivity, setLastActivity] = useState<Activity | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [responses, setResponses] = useState<Response[]>([])
  const [loading, setLoading] = useState(true)
  // Stable ref so the INSERT closure always has the current activity id
  const lastActivityIdRef = useRef<string | null>(null)
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function fetchResponses(activityId: string) {
    const { data } = await supabase
      .from('responses')
      .select('*')
      .eq('activity_id', activityId)
      .order('created_at', { ascending: false })
    if (data) setResponses(data)
  }

  async function syncActiveActivity() {
    const { data } = await supabase
      .from('activities')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()

    if (data) {
      const switched = data.id !== lastActivityIdRef.current
      setLastActivity(data)
      setIsLive(true)
      lastActivityIdRef.current = data.id
      if (switched) await fetchResponses(data.id)
    } else {
      setIsLive(false)
      // Don't clear lastActivity or lastActivityIdRef — keep showing the last active activity
    }
  }

  useEffect(() => {
    async function init() {
      await syncActiveActivity()
      setLoading(false)
    }
    init()

    const activitiesChannel = supabase
      .channel('wall-activities')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, () => {
        syncActiveActivity()
      })
      .subscribe()

    const responsesChannel = supabase
      .channel('wall-responses')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'responses' },
        (payload) => {
          const r = payload.new as Response
          if (r.activity_id === lastActivityIdRef.current) {
            setResponses((prev) => [r, ...prev])
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'responses' },
        () => {
          // Can't filter by activity_id without REPLICA IDENTITY FULL — debounced refetch
          if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
          refetchTimerRef.current = setTimeout(() => {
            if (lastActivityIdRef.current) fetchResponses(lastActivityIdRef.current)
          }, 200)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(activitiesChannel)
      supabase.removeChannel(responsesChannel)
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center">
        <p className="text-lectern-slate/50">Loading…</p>
      </div>
    )
  }

  if (!lastActivity) {
    return (
      <div className="min-h-screen bg-lectern-sand flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-2xl font-semibold text-lectern-slate mb-2">No activity yet</p>
          <p className="text-lectern-slate/60 mb-6">Check back once an activity is live.</p>
          <Link href="/" className="text-lectern-teal font-semibold hover:underline">
            ← Back
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 bg-lectern-sand border-b border-lectern-slate/10 px-4 py-3 flex items-center gap-3">
        <Link
          href="/"
          className="text-lectern-slate/60 hover:text-lectern-slate transition-colors text-sm font-medium shrink-0"
        >
          ← Back
        </Link>
        <p className="flex-1 min-w-0 text-lectern-slate font-semibold text-base truncate">
          {lastActivity.title}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          {isLive ? (
            <>
              <span className="w-2 h-2 rounded-full bg-lectern-coral animate-live-pulse" />
              <span className="text-xs font-semibold text-lectern-coral">Live</span>
            </>
          ) : (
            <span className="text-xs font-medium text-lectern-slate/40">Paused</span>
          )}
        </div>
      </header>

      <main className="px-4 py-5">
        <p className="text-lectern-slate/50 text-sm mb-4 tabular-nums">
          {responses.length} {responses.length === 1 ? 'response' : 'responses'}
        </p>

        {responses.length === 0 ? (
          <p className="text-lectern-slate/35 text-center py-16 text-lg">No responses yet.</p>
        ) : (
          <div className="columns-1 sm:columns-2 gap-4">
            {responses.map((response, i) => (
              <div
                key={response.id}
                style={{ backgroundColor: noteBg(i) }}
                className="rounded-xl p-3 mb-3 break-inside-avoid shadow-sm"
              >
                <p className="text-lectern-slate text-base leading-snug">{response.content}</p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
