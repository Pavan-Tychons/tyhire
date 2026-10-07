"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteJson, getJson, postJson } from "@/lib/api";
import { useDialog } from "@/components/Dialog";
import type { Job } from "@/lib/types";

export default function JobsPage() {
  const { confirm, prompt, notify } = useDialog();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    getJson<Job[]>("/jobs")
      .then(setJobs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleClone(jobId: string) {
    const cloned = await postJson<Job>(`/jobs/${jobId}/clone`, {});
    router.push(`/jobs/${cloned.id}`);
  }

  async function handleArchive(jobId: string) {
    const reason = await prompt({
      title: "Archive job",
      description: "Reason for archiving this job (goes into the audit log):",
    });
    if (!reason) return;
    await postJson(`/jobs/${jobId}/archive`, { reason });
    refresh();
  }

  async function handleUnarchive(jobId: string) {
    await postJson(`/jobs/${jobId}/unarchive`, {});
    refresh();
  }

  async function handleDelete(jobId: string, title: string) {
    const ok = await confirm({
      title: "Delete job",
      description:
        `Permanently delete "${title}"? This also permanently deletes every candidate ` +
        `attached to this job — their resumes, AI scores, and interview history all go ` +
        `with it. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await deleteJson<{ deleted: boolean; candidates_removed: number }>(
        `/jobs/${jobId}`,
        {}
      );
      if (result.candidates_removed > 0) {
        await notify({
          title: "Job deleted",
          description: `Deleted "${title}" and ${result.candidates_removed} candidate(s) attached to it.`,
        });
      }
      refresh();
    } catch (err) {
      await notify({
        title: "Could not delete job",
        description: err instanceof Error ? err.message : "Could not delete this job.",
      });
    }
  }

  const activeJobs = jobs.filter((j) => !j.archived);
  const archivedJobs = jobs.filter((j) => j.archived);

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <Link href="/jobs/new" className="btn-primary">
          + New job
        </Link>
      </div>

      {loading && <p className="text-zinc-500 text-sm">Loading…</p>}
      {!loading && jobs.length === 0 && (
        <p className="text-zinc-500 text-sm">No jobs yet. Create one to get started.</p>
      )}
      {!loading && activeJobs.length > 0 && (
        <p className="text-xs text-zinc-400">
          To permanently delete a job, archive it first — the delete option appears in the
          Archived list below.
        </p>
      )}

      <ul className="divide-y divide-zinc-200 border border-zinc-200 rounded-md">
        {activeJobs.map((job) => (
          <li key={job.id} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50">
            <Link href={`/jobs/${job.id}`} className="flex-1 min-w-0">
              <p className="font-medium">{job.title}</p>
              <p className="text-xs text-zinc-500">
                {job.level} · {job.work_mode} · {job.required_skills.join(", ")}
              </p>
            </Link>
            <span className="flex gap-2 shrink-0 ml-3">
              <button
                onClick={() => handleClone(job.id)}
                className="btn-outline text-xs px-2 py-1"
                title="Duplicate this job's settings into a new one"
              >
                Clone
              </button>
              <button
                onClick={() => handleArchive(job.id)}
                className="btn-outline text-xs px-2 py-1"
              >
                Archive
              </button>
            </span>
          </li>
        ))}
      </ul>

      {archivedJobs.length > 0 && (
        <div>
          <h2 className="font-medium text-sm text-zinc-600 mb-2">Archived ({archivedJobs.length})</h2>
          <ul className="space-y-1 text-sm">
            {archivedJobs.map((job) => (
              <li
                key={job.id}
                className="flex items-center justify-between gap-2 border border-zinc-200 rounded-md px-3 py-2 text-zinc-500"
              >
                <span>
                  {job.title}
                  {job.archived_reason && ` — ${job.archived_reason}`}
                </span>
                <span className="flex gap-2 shrink-0">
                  <button onClick={() => handleUnarchive(job.id)} className="btn-outline text-xs px-2 py-1">
                    Unarchive
                  </button>
                  <button
                    onClick={() => handleDelete(job.id, job.title)}
                    className="btn-danger-outline text-xs px-2 py-1"
                  >
                    Delete permanently
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
