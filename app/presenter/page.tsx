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

export default function PresenterPage() {
  const [activity, setActivity] = useState<Activity | null | undefined>(undefined)
  const [responses, setResponses] = useState<Response[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [participantUrl, setParticipantUrl] = useState('')
  const seenIds = useRef(new Set<string>())

  function prependUnseen(incoming: Response[]) {
    const unseen = incoming.filter((r) => !seenIds.current.has(r.id))
    unseen.forEach((r) => seenIds.current.add(r.id))
    if (unseen.length > 0) {
      setResponses((prev) => [...unseen, ...prev])
    }
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
    return data
  }

  async function fetchResponses(activityId: string) {
    const { data } = await supabase
      .from('responses')
      .select('*')
      .eq('activity_id', activityId)
      .order('created_at', { ascending: false })

    if (data) prependUnseen(data)
  }

  useEffect(() => {
    setParticipantUrl(window.location.origin)
  }, [])

  useEffect(() => {
    async function init() {
      const act = await fetchActiveActivity()
      if (act) await fetchResponses(act.id)
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
          prependUnseen([payload.new as Response])
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(activitiesChannel)
      supabase.removeChannel(responsesChannel)
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500">{error}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      {participantUrl && (
        <div className="fixed bottom-6 right-6 bg-white rounded-xl shadow-lg p-4 flex flex-col items-center gap-2">
          <QRCodeSVG value={participantUrl} size={250} level="M" />
          <p className="text-xs font-mono text-zinc-500">{participantUrl}</p>
        </div>
      )}
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          {activity ? (
            <h1 className="text-3xl font-bold text-zinc-900">{activity.title}</h1>
          ) : (
            <h1 className="text-3xl font-bold text-zinc-400">No active activity</h1>
          )}
          <p className="text-zinc-500 mt-1 text-sm">
            {responses.length} {responses.length === 1 ? 'response' : 'responses'}
          </p>
        </div>

        {responses.length === 0 ? (
          <p className="text-zinc-400 text-center py-16">No responses yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {responses.map((response) => (
              <div
                key={response.id}
                className="bg-yellow-100 border border-yellow-200 rounded-lg p-4 shadow-sm"
              >
                <p className="text-zinc-800 text-sm leading-relaxed">{response.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
