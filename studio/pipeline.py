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
    speed = float(spec.get("speed", 1.0))
    parts, t = [], 0.0
    for sc in spec["scenes"]:
        b = sc.get("bg") or {}
        ci = b.get("clip")
        if ci is not None and ci in fixed and b.get("audio", True):
            parts.append((fixed[ci], b.get("start", 0), sc["dur"], t))
        t += sc["dur"]
    # Whoosh en los cambios de escena marcados con "whoosh": true (ritmo de creadora)
    wh = None
    t3 = 0.0
    for sc in spec["scenes"]:
        if sc.get("whoosh"):
            if wh is None:
                wh = os.path.join(workdir, "whoosh.wav")
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=c=pink:r=44100:d=0.45:a=0.6",
                                "-af", "highpass=f=400,lowpass=f=6000,afade=t=in:d=0.3:curve=exp,afade=t=out:st=0.3:d=0.15,volume=0.35", wh], check=True)
            parts.append((wh, 0, 0.45, max(0.0, t3 - 0.3)))
        t3 += sc["dur"]
    # Efectos de cine: "impact" (golpe grave al empezar la escena) y "riser" (subida que termina al final de la escena)
    t4 = 0.0
    fx = {}
    for sc in spec["scenes"]:
        for kind in (sc.get("sfx") or []):
            if kind not in fx:
                path = os.path.join(workdir, f"sfx_{kind}.wav")
                if kind == "impact":
                    src = ["-f", "lavfi", "-i", "sine=f=55:d=2.2", "-f", "lavfi", "-i", "anoisesrc=c=brown:d=2.2:a=0.5"]
                    af = "[0:a][1:a]amix=inputs=2:weights=1 0.35,lowpass=f=180,afade=t=in:d=0.01,afade=t=out:st=0.15:d=2.0:curve=exp,volume=2.2,aecho=0.8:0.6:120:0.35"
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + src + ["-filter_complex", af, path], check=True)
                else:
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=c=white:d=1.6:a=0.4",
                                    "-af", "highpass=f=800,lowpass=f=9000,afade=t=in:d=1.5:curve=exp,afade=t=out:st=1.5:d=0.1,volume=0.5", path], check=True)
                fx[kind] = path
            if kind == "impact":
                parts.append((fx[kind], 0, 2.2 / speed, t4))
            else:
                parts.append((fx[kind], 0, 1.6 / speed, max(0.0, t4 + sc["dur"] - 1.6)))
        t4 += sc["dur"]
    # Escenas con voz en off propia (TTS de la modelo), por ejemplo la explicacion en graficos
    t2 = 0.0
    for k, sc in enumerate(spec["scenes"]):
        if sc.get("audio"):
            parts.append((download(sc["audio"], os.path.join(workdir, f"vo_{k}.mp3")), 0, sc["dur"], t2))
        t2 += sc["dur"]
    if not parts:
        return None
    inputs, fc = [], []
    for k, (src, st, dur, off) in enumerate(parts):
        inputs += ["-i", src]
        ms = int(off * 1000)
        tempo = f"atempo={speed}," if speed != 1 else ""
        fc.append(f"[{k}:a]atrim={st}:{st + dur * speed},asetpts=PTS-STARTPTS,{tempo}aresample=44100,aformat=channel_layouts=stereo,"
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
        compose.compose(anim, final, clip=clip, music=music, voice=voice, music_under_voice=float(spec.get("music_volume", 0.12)))
        if not os.path.exists(cover):
            render.still(spec, spec.get("cover_at", 2.5), cover)
        outs = [(final, "video/mp4"), (cover, "image/png")]
        # Control de calidad automatico para videos UGC (manos, cortes de voz y hoja de contacto)
        if spec.get("ugc_request_id") and has_clips:
            try:
                from studio import qa
                outs += qa.run(spec, clip_paths, final, workdir)
            except Exception as e:
                print("control de calidad fallo (el video sigue):", e)
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
