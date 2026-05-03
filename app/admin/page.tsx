'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Activity = {
  id: string
  created_at: string
  title: string
  is_active: boolean
}

type ActivityWithCount = Activity & { responseCount: number }

export default function AdminPage() {
  const [activities, setActivities] = useState<ActivityWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  // Prevents double-save when Enter triggers blur after keydown handler commits
  const commitRef = useRef(false)

  async function fetchAll() {
    const [{ data: acts }, { data: resps }] = await Promise.all([
      supabase.from('activities').select('*').order('created_at', { ascending: false }),
      supabase.from('responses').select('activity_id'),
    ])

    if (!acts) return

    const counts: Record<string, number> = {}
    for (const r of resps ?? []) {
      counts[r.activity_id] = (counts[r.activity_id] ?? 0) + 1
    }

    setActivities(acts.map((a) => ({ ...a, responseCount: counts[a.id] ?? 0 })))
  }

  useEffect(() => {
    fetchAll().then(() => setLoading(false))

    const activitiesChannel = supabase
      .channel('admin-activities')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, () => {
        fetchAll()
      })
      .subscribe()

    const responsesChannel = supabase
      .channel('admin-responses')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'responses' },
        (payload) => {
          const activityId = (payload.new as { activity_id: string }).activity_id
          setActivities((prev) =>
            prev.map((a) =>
              a.id === activityId ? { ...a, responseCount: a.responseCount + 1 } : a
            )
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(activitiesChannel)
      supabase.removeChannel(responsesChannel)
    }
  }, [])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  async function createActivity() {
    if (!newTitle.trim() || creating) return
    setCreating(true)
    await supabase.from('activities').insert({ title: newTitle.trim(), is_active: false })
    setNewTitle('')
    setCreating(false)
  }

  // Set target active first (no "no active" window for participants),
  // then clear all others. Two updates because the client library has no transactions.
  async function setActive(id: string) {
    await supabase.from('activities').update({ is_active: true }).eq('id', id)
    await supabase.from('activities').update({ is_active: false }).neq('id', id)
  }

  async function pauseAll() {
    await supabase.from('activities').update({ is_active: false }).eq('is_active', true)
  }

  function startEdit(activity: ActivityWithCount) {
    commitRef.current = false
    setEditingId(activity.id)
    setEditingTitle(activity.title)
  }

  async function saveTitle(id: string, title: string) {
    if (commitRef.current) return
    commitRef.current = true
    setEditingId(null)
    const trimmed = title.trim()
    if (trimmed) {
      await supabase.from('activities').update({ title: trimmed }).eq('id', id)
    }
  }

  function cancelEdit() {
    if (commitRef.current) return
    commitRef.current = true
    setEditingId(null)
  }

  async function clearResponses(id: string) {
    if (!confirm('Delete all responses for this activity?')) return
    // Optimistic update — realtime DELETE events don't carry activity_id without
    // REPLICA IDENTITY FULL, so we update the count locally instead of re-fetching.
    setActivities((prev) =>
      prev.map((a) => (a.id === id ? { ...a, responseCount: 0 } : a))
    )
    await supabase.from('responses').delete().eq('activity_id', id)
  }

  async function deleteActivity(id: string) {
    if (!confirm('Delete this activity and all its responses?')) return
    await supabase.from('activities').delete().eq('id', id)
  }

  const hasActive = activities.some((a) => a.is_active)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-zinc-900 mb-6">Activity Admin</h1>

        <div className="flex gap-3 mb-6">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createActivity()}
            placeholder="Enter activity prompt..."
            className="flex-1 border border-zinc-300 rounded px-3 py-2 text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <button
            onClick={createActivity}
            disabled={creating || !newTitle.trim()}
            className="px-4 py-2 bg-zinc-800 text-white rounded hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating...' : 'Create Activity'}
          </button>
          {hasActive && (
            <button
              onClick={pauseAll}
              className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600"
            >
              Pause
            </button>
          )}
        </div>

        {activities.length === 0 ? (
          <p className="text-zinc-400">No activities yet.</p>
        ) : (
          <div className="border border-zinc-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-zinc-500 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Responses</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {activities.map((activity) => (
                  <tr key={activity.id} className={activity.is_active ? 'bg-green-50' : ''}>
                    <td className="px-4 py-3 max-w-xs">
                      <div className="flex items-center gap-2">
                        {activity.is_active && (
                          <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                            Live
                          </span>
                        )}
                        {editingId === activity.id ? (
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveTitle(activity.id, editingTitle)
                              if (e.key === 'Escape') cancelEdit()
                            }}
                            onBlur={() => saveTitle(activity.id, editingTitle)}
                            className="border border-zinc-300 rounded px-2 py-1 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 w-full min-w-0"
                          />
                        ) : (
                          <span
                            className="cursor-pointer hover:underline text-zinc-900"
                            onClick={() => startEdit(activity)}
                            title="Click to edit"
                          >
                            {activity.title}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 whitespace-nowrap">
                      {new Date(activity.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-zinc-700 tabular-nums">
                      {activity.responseCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 flex-wrap">
                        {!activity.is_active && (
                          <button
                            onClick={() => setActive(activity.id)}
                            className="px-2 py-1 text-xs bg-zinc-800 text-white rounded hover:bg-zinc-700"
                          >
                            Set Active
                          </button>
                        )}
                        <button
                          onClick={() => clearResponses(activity.id)}
                          className="px-2 py-1 text-xs border border-zinc-300 text-zinc-600 rounded hover:bg-zinc-50"
                        >
                          Clear responses
                        </button>
                        <button
                          onClick={() => deleteActivity(activity.id)}
                          className="px-2 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
