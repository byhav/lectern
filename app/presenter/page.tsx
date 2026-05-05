'use client'

import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
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

export default function PresenterPage() {
  const [activity, setActivity] = useState<Activity | null | undefined>(undefined)
  const [responses, setResponses] = useState<Response[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [participantUrl, setParticipantUrl] = useState('')
  const [animatingIds, setAnimatingIds] = useState(new Set<string>())
  const [connectionMode, setConnectionMode] = useState<'realtime' | 'polling'>('realtime')
  const seenIds = useRef(new Set<string>())
  const initialLoadDone = useRef(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activityIdRef = useRef<string | null>(null)

  function startPolling() {
    if (pollingRef.current) return
    setConnectionMode('polling')
    pollingRef.current = setInterval(() => {
      if (activityIdRef.current) fetchResponses(activityIdRef.current)
    }, 4000)
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    setConnectionMode('realtime')
  }

  function addAnimating(ids: string[]) {
    setAnimatingIds((prev) => new Set([...prev, ...ids]))
    setTimeout(() => {
      setAnimatingIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }, 500)
  }

  function prependUnseen(incoming: Response[], animate = false) {
    const unseen = incoming.filter((r) => !seenIds.current.has(r.id))
    unseen.forEach((r) => seenIds.current.add(r.id))
    if (unseen.length === 0) return
    if (animate) addAnimating(unseen.map((r) => r.id))
    setResponses((prev) => [...unseen, ...prev])
  }

  async function fetchActiveActivity(): Promise<Activity | null> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      setError('Failed to load activity.')
      return null
    }
    setActivity(data ?? null)
    activityIdRef.current = data?.id ?? null
    return data
  }

  async function fetchResponses(activityId: string) {
    const { data } = await supabase
      .from('responses')
      .select('*')
      .eq('activity_id', activityId)
      .order('created_at', { ascending: false })

    if (data) prependUnseen(data, false)
  }

  useEffect(() => {
    setParticipantUrl(window.location.origin)
  }, [])

  useEffect(() => {
    async function init() {
      const act = await fetchActiveActivity()
      if (act) await fetchResponses(act.id)
      initialLoadDone.current = true
      setLoading(false)
    }
    init()

    const activitiesChannel = supabase
      .channel('presenter-activities')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'activities' },
        async () => {
          const act = await fetchActiveActivity()
          if (act) await fetchResponses(act.id)
        }
      )
      .subscribe()

    const responsesChannel = supabase
      .channel('presenter-responses')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'responses' },
        (payload) => {
          prependUnseen([payload.new as Response], initialLoadDone.current)
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          stopPolling()
        } else if (
          status === 'TIMED_OUT' ||
          status === 'CLOSED' ||
          status === 'CHANNEL_ERROR'
        ) {
          startPolling()
        }
      })

    return () => {
      supabase.removeChannel(activitiesChannel)
      supabase.removeChannel(responsesChannel)
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-lectern-slate/40">Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-lectern-coral font-medium">{error}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white p-10 pb-40">
      {participantUrl && (
        <div className="fixed bottom-6 right-6 bg-white rounded-2xl shadow-xl p-5 flex flex-col items-center gap-3 border border-lectern-slate/10">
          <QRCodeSVG value={participantUrl} size={220} level="M" />
          <p className="text-xs font-mono text-lectern-slate/50 text-center break-all max-w-[220px]">
            {participantUrl}
          </p>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-3 h-3 rounded-full bg-lectern-coral animate-live-pulse shrink-0" />
            <span className="text-lectern-teal font-semibold text-xl tabular-nums">
              {responses.length} {responses.length === 1 ? 'response' : 'responses'}
            </span>
            {connectionMode === 'realtime' ? (
              <span className="text-xs font-medium text-emerald-500">● realtime</span>
            ) : (
              <span className="text-xs font-medium text-amber-400 animate-pulse">⟳ polling</span>
            )}
          </div>
          {activity ? (
            <h1 className="text-6xl font-bold text-lectern-slate leading-tight">
              {activity.title}
            </h1>
          ) : (
            <h1 className="text-6xl font-bold text-lectern-slate/30 leading-tight">
              No active activity
            </h1>
          )}
        </div>

        {responses.length === 0 ? (
          <p className="text-lectern-slate/25 text-center py-20 text-2xl">No responses yet.</p>
        ) : (
          <div className="columns-3 gap-5">
            {responses.map((response, i) => (
              <div
                key={response.id}
                style={{ backgroundColor: noteBg(i) }}
                className={[
                  'rounded-xl p-3 mb-5 shadow-sm break-inside-avoid',
                  animatingIds.has(response.id) ? 'animate-slide-in' : '',
                ].join(' ')}
              >
                <p className="text-lectern-slate text-xl leading-snug">{response.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
