"""Orquestador: lee un trabajo de Supabase, renderiza y devuelve los archivos.

Uso en GitHub Actions:   python -m studio.pipeline --job <uuid>
Uso local de prueba:     python -m studio.pipeline --spec specs/ejemplo.json --out salida/
"""
import argparse, json, os, subprocess, sys, tempfile, urllib.request

from studio import render, compose

URL = os.environ.get("STUDIO_URL", "https://nhvtrxxaggusvlimavdn.supabase.co/functions/v1/analytiq-studio")
SECRET = os.environ.get("STUDIO_SECRET", "")

UGC_URL = os.environ.get("UGC_URL", "https://nhvtrxxaggusvlimavdn.supabase.co/functions/v1/ugc-studio")

def call(action, payload=None, raw=None, headers=None, url=None):
    h = {"x-studio-secret": SECRET, "x-action": action}
    if headers: h.update(headers)
    if raw is not None:
        data = raw
    else:
        data = json.dumps({"action": action, **(payload or {})}).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url or URL, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        j = json.loads(r.read())
    if not j.get("ok"):
        raise RuntimeError(f"{action}: {j.get('error')}")
    return j["result"]

def download(url, path):
    if os.path.exists(url):
        return url
    urllib.request.urlretrieve(url, path)
    return path

def voice_track(spec, clip_paths, workdir):
    """Arma la pista de voz del reel con el audio de cada clip en su escena (modelos UGC que hablan).
    Si el spec trae "voice_model", cada clip pasa por el cambiador de voz para que suene con la voz oficial."""
    model = spec.get("voice_model")
    fixed = {}
    for i, p in enumerate(clip_paths):
        if not p or not has_audio(p):
            continue
        if model:
            wav = os.path.join(workdir, f"voz_{i}_orig.mp3")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", p, "-vn", "-ac", "1", "-ar", "44100", "-b:a", "192k", wav], check=True)
            try:
                with open(wav, "rb") as f:
                    res = call("voice_change", raw=f.read(), headers={"x-model": model, "Content-Type": "audio/mpeg"}, url=UGC_URL)
                fixed[i] = download(res["url"], os.path.join(workdir, f"voz_{i}.mp3"))
            except Exception as e:
                print("cambio de voz fallo, uso la voz original:", e)
                fixed[i] = wav
        else:
            fixed[i] = p
    parts, t = [], 0.0
    for sc in spec["scenes"]:
        b = sc.get("bg") or {}
        ci = b.get("clip")
        if ci is not None and ci in fixed and b.get("audio", True):
            parts.append((fixed[ci], b.get("start", 0), sc["dur"], t))
        t += sc["dur"]
    if not parts:
        return None
    inputs, fc = [], []
    for k, (src, st, dur, off) in enumerate(parts):
        inputs += ["-i", src]
        ms = int(off * 1000)
        fc.append(f"[{k}:a]atrim={st}:{st + dur},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,"
                  f"afade=t=in:d=0.05,afade=t=out:st={max(0, dur - 0.08):.3f}:d=0.08,adelay={ms}|{ms}[p{k}]")
    fc.append("".join(f"[p{k}]" for k in range(len(parts))) + f"amix=inputs={len(parts)}:normalize=0,atrim=0:{t:.3f}[a]")
    out = os.path.join(workdir, "voz.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + inputs + ["-filter_complex", ";".join(fc), "-map", "[a]", out], check=True)
    return out

def has_audio(path):
    try:
        return compose.probe(path)[1]
    except Exception:
        return False

def build(spec, workdir, clip_url=None, music_url=None):
    kind = spec.get("kind", "reel")
    outs = []
    if kind == "reel":
        anim = os.path.join(workdir, "anim.mp4")
        cover = os.path.join(workdir, "portada.png")
        clip_paths = []
        for i, c in enumerate(spec.get("clips") or []):
            src = c.get("url") or c.get("path")
            clip_paths.append(download(src, os.path.join(workdir, f"clip_{i}.mp4")) if src else None)
        has_clips = any(clip_paths)
        render.render_reel(spec, anim, clips=clip_paths, cover=cover if has_clips else None)
        # Modo clasico: un solo clip de gancho antes de la animacion
        clip = download(clip_url, os.path.join(workdir, "clip.mp4")) if clip_url and not has_clips else None
        music = download(music_url, os.path.join(workdir, "music.bin")) if music_url else None
        final = os.path.join(workdir, "reel.mp4")
        voice = voice_track(spec, clip_paths, workdir) if spec.get("voice") and has_clips else None
        compose.compose(anim, final, clip=clip, music=music, voice=voice)
        if not os.path.exists(cover):
            render.still(spec, spec.get("cover_at", 2.5), cover)
        outs = [(final, "video/mp4"), (cover, "image/png")]
    else:
        outs = [(p, "image/png") for p in render.render_slides(spec, os.path.join(workdir, "slide"))]
    return outs

def run_job(job_id):
    job = call("job_get", {"job_id": job_id})
    try:
        with tempfile.TemporaryDirectory() as wd:
            files = build(job["spec"], wd, job.get("clip_url"), job.get("music_url"))
            urls = []
            for path, ctype in files:
                with open(path, "rb") as f:
                    res = call("job_file", raw=f.read(), headers={
                        "x-job": job_id, "x-name": os.path.basename(path), "Content-Type": ctype})
                urls.append(res["url"])
        call("job_done", {"job_id": job_id, "files": urls})
        print("listo:", urls)
    except Exception as e:
        call("job_fail", {"job_id": job_id, "error": str(e)[:500]})
        raise

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job")
    ap.add_argument("--spec")
    ap.add_argument("--out", default="salida")
    ap.add_argument("--clip")
    ap.add_argument("--music")
    a = ap.parse_args()
    if a.job:
        run_job(a.job)
    elif a.spec:
        os.makedirs(a.out, exist_ok=True)
        spec = json.load(open(a.spec, encoding="utf-8"))
        for p, _ in build(spec, a.out, a.clip, a.music):
            print(p)
    else:
        sys.exit("usa --job o --spec")

if __name__ == "__main__":
    main()
