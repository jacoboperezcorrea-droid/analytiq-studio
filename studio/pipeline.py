"""Orquestador: lee un trabajo de Supabase, renderiza y devuelve los archivos.

Uso en GitHub Actions:   python -m studio.pipeline --job <uuid>
Uso local de prueba:     python -m studio.pipeline --spec specs/ejemplo.json --out salida/
"""
import argparse, json, os, sys, tempfile, urllib.request

from studio import render, compose

URL = os.environ.get("STUDIO_URL", "https://nhvtrxxaggusvlimavdn.supabase.co/functions/v1/analytiq-studio")
SECRET = os.environ.get("STUDIO_SECRET", "")

def call(action, payload=None, raw=None, headers=None):
    h = {"x-studio-secret": SECRET, "x-action": action}
    if headers: h.update(headers)
    if raw is not None:
        data = raw
    else:
        data = json.dumps({"action": action, **(payload or {})}).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(URL, data=data, headers=h, method="POST")
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

def build(spec, workdir, clip_url=None, music_url=None):
    kind = spec.get("kind", "reel")
    outs = []
    if kind == "reel":
        anim = os.path.join(workdir, "anim.mp4")
        render.render_reel(spec, anim)
        clip = download(clip_url, os.path.join(workdir, "clip.mp4")) if clip_url else None
        music = download(music_url, os.path.join(workdir, "music.bin")) if music_url else None
        final = os.path.join(workdir, "reel.mp4")
        compose.compose(anim, final, clip=clip, music=music)
        cover = os.path.join(workdir, "portada.png")
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
