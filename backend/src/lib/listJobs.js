import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { processAcceptedImport } from "./parsePaste.js";

const queue = [];
let pumping = false;

async function setProcess(client, listId, fields) {
  const { error } = await client.from("lists").update(fields).eq("id", listId);
  if (error) throw error;
}

async function runJob(job) {
  const client = getSupabaseAdmin();
  const { data, error } = await client
    .from("lists")
    .select("id")
    .eq("id", job.listId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;

  const stats = await processAcceptedImport(client, job.listId, job.raw, job.price);
  await setProcess(client, job.listId, {
    process_status: "ready",
    process_error: null,
    process_stats: stats,
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await runJob(job);
    } catch (err) {
      console.error("List process failed", job && job.listId, err);
      try {
        await setProcess(getSupabaseAdmin(), job.listId, {
          process_status: "error",
          process_error: (err && err.message) || "Could not process list.",
        });
      } catch (recordErr) {
        console.error("Could not record list process error", job && job.listId, recordErr);
      }
    }
  }
  pumping = false;
}

export function enqueueListProcess(job) {
  queue.push(job);
  pump();
}

export async function resumeIncompleteJobs() {
  const client = getSupabaseAdmin();
  const { data, error } = await client
    .from("lists")
    .select("id,content,price")
    .eq("process_status", "processing");
  if (error) throw error;
  (data || []).forEach(function (row) {
    enqueueListProcess({ listId: row.id, raw: row.content || "", price: row.price });
  });
}
