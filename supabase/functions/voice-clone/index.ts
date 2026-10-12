// Clona en ElevenLabs (Instant Voice Clone) la voz nativa de una toma de Veo, para unificar la voz de todo un video.
// Auth: x-cron-secret. Body: { name, gh_path?: "review/v5c/v1.mp3" (rama review del repo), audio_url?, description? }
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
async function secret(fn: string, name: string) { const { data } = await sb.rpc(fn, { p_name: name }); return data as string | null; }

async function audioBytes(b: any): Promise<{ bytes: Uint8Array; type: string; name: string }> {
  if (b.gh_path) {
    const token = await secret("analytiq_get_secret", "analytiq_github_token");
    const r = await fetch(`https://api.github.com/repos/jacoboperezcorrea-droid/analytiq-studio/contents/${b.gh_path}?ref=review`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw", "User-Agent": "voice-clone" },
    });
    if (!r.ok) throw new Error("GitHub " + r.status);
    return { bytes: new Uint8Array(await r.arrayBuffer()), type: "audio/mpeg", name: "muestra.mp3" };
  }
  const r = await fetch(b.audio_url);
  if (!r.ok) throw new Error("No pude bajar el audio " + r.status);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") || "audio/mpeg", name: "muestra" };
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== (await secret("com_get_secret", "hallazgo_cron_secret"))) return json({ error: "unauthorized" }, 401);
    const b = await req.json();
    const key = await secret("ugc_get_secret", "ugc_elevenlabs_key");
    if (!key) throw new Error("No hay ugc_elevenlabs_key");
    const a = await audioBytes(b);
    const form = new FormData();
    form.append("name", b.name || "Voz clonada");
    form.append("description", b.description || "Clon de la voz nativa de una toma de Veo");
    form.append("remove_background_noise", "true");
    form.append("files", new Blob([a.bytes], { type: a.type }), a.name);
    const r = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": key }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("ElevenLabs: " + JSON.stringify(j.detail || j).slice(0, 300));
    return json({ ok: true, voice_id: j.voice_id, bytes: a.bytes.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
