"""Control de calidad automatico de un reel UGC (corre gratis en GitHub Actions, despues del render).

Mediciones con vision por computador y audio, sin IA de pago:
  - manos: MediaPipe Hands en cuadros de cada toma. Mas de 2 manos en un cuadro = posible brazo o mano de mas.
  - cortes de voz: deteccion de silencios (ffmpeg) en el audio de cada toma. Si la modelo sigue hablando
    justo donde el editor corta la toma, la frase queda cortada.
  - hoja de contacto: 16 cuadros del video final en una sola imagen, para que el agente de calidad
    (Claude con vision, en ugc-estudio) revise textos cortados, marca, ropa, caras y deformaciones.
"""
import json, os, re, subprocess

def _frames(path, times, size=512):
    """Extrae cuadros RGB (numpy) en los segundos pedidos."""
    import numpy as np
    out = []
    for t in times:
        raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
                              "-vf", f"scale={size}:-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
        if not raw:
            continue
        info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                               "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(",")
        w0, h0 = int(info[0]), int(info[1])
        h = int(round(h0 * size / w0 / 2) * 2)
        if len(raw) != size * h * 3:
            continue
        out.append((t, np.frombuffer(raw, dtype=np.uint8).reshape(h, size, 3)))
    return out

HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"

def _hand_model(workdir):
    import urllib.request
    path = os.path.join(workdir, "hand_landmarker.task")
    if not os.path.exists(path):
        urllib.request.urlretrieve(HAND_MODEL_URL, path)
    return path

def hands_check(clip_paths, windows, workdir):
    """Cuenta manos por cuadro en la parte usada de cada toma (MediaPipe Hand Landmarker). Devuelve alertas por toma."""
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import vision, BaseOptions
        opts = vision.HandLandmarkerOptions(base_options=BaseOptions(model_asset_path=_hand_model(workdir)),
                                            running_mode=vision.RunningMode.IMAGE, num_hands=4,
                                            min_hand_detection_confidence=0.6, min_hand_presence_confidence=0.6)
        det = vision.HandLandmarker.create_from_options(opts)
    except Exception as e:
        return {"error": f"MediaPipe no disponible: {e}", "alertas": []}
    res = []
    for i, p in enumerate(clip_paths):
        if not p or i not in windows:
            continue
        a, b = windows[i]
        n = 10
        times = [a + (b - a) * k / (n - 1) for k in range(n)]
        maxh, bad = 0, []
        for t, fr in _frames(p, times):
            r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=fr.copy()))
            c = len(r.hand_landmarks or [])
            maxh = max(maxh, c)
            if c > 2:
                bad.append(round(t, 1))
        res.append({"toma": i + 1, "max_manos": maxh, "segundos_con_mas_de_2": bad})
    det.close()
    return {"tomas": res, "alertas": [f"Toma {r['toma']}: se detectan {r['max_manos']} manos en el cuadro (segundos {r['segundos_con_mas_de_2']})" for r in res if r["segundos_con_mas_de_2"]]}

def _speech_segments(path):
    """Tramos con voz segun silencedetect: lista de (inicio, fin) donde NO hay silencio."""
    err = subprocess.run(["ffmpeg", "-i", path, "-vn", "-af", "silencedetect=noise=-32dB:d=0.18", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                               capture_output=True, text=True).stdout.strip() or 0)
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", err)]
    sil = list(zip(starts, ends + [dur] * (len(starts) - len(ends))))
    return sil, dur

def cut_check(clip_paths, windows):
    """Revisa si el corte de cada toma cae en medio de una palabra (voz activa en el punto de corte)."""
    out, alerts = [], []
    for i, p in enumerate(clip_paths):
        if not p or i not in windows:
            continue
        try:
            sil, dur = _speech_segments(p)
        except Exception:
            continue
        a, b = windows[i]
        silent_at = lambda t: any(s - 0.05 <= t <= e + 0.05 for s, e in sil)
        # el silencio que llega hasta el final de la toma marca donde termino de hablar
        trailing = [s for s, e in sil if e >= dur - 0.15]
        last_speech_end = min(trailing) if trailing else dur
        cut_mid = not silent_at(b)
        start_mid = a > 0.05 and not silent_at(a)
        habla_hasta = round(min(last_speech_end, dur), 2)
        out.append({"toma": i + 1, "usa_desde": round(a, 2), "usa_hasta": round(b, 2), "habla_hasta": habla_hasta, "corta_hablando": cut_mid, "empieza_hablando": start_mid})
        if cut_mid:
            alerts.append(f"Toma {i + 1}: el video corta en el segundo {b:.1f} mientras la modelo sigue hablando (habla hasta {habla_hasta:.1f})")
        if start_mid:
            alerts.append(f"Toma {i + 1}: entra en el segundo {a:.1f} con la modelo ya hablando")
    return {"tomas": out, "alertas": alerts}

def contact_sheet(video, out_path, n=16):
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                               capture_output=True, text=True).stdout.strip())
    fps = n / max(dur, 1)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vf", f"fps={fps:.4f},scale=300:-2,tile=8x2:padding=4",
                    "-frames:v", "1", "-q:v", "4", out_path], check=True)
    return out_path

def windows_from_spec(spec):
    """Tramo usado de cada toma (en segundos del clip original) segun las escenas del spec."""
    speed = float(spec.get("speed", 1.0))
    win = {}
    for sc in spec.get("scenes", []):
        b = sc.get("bg") or {}
        ci = b.get("clip")
        if ci is None or b.get("audio", True) is False:
            continue
        a = float(b.get("start", 0)); e = a + float(sc["dur"]) * speed
        lo, hi = win.get(ci, (a, e))
        win[ci] = (min(lo, a), max(hi, e))
    return win

def run(spec, clip_paths, video, workdir):
    win = windows_from_spec(spec)
    report = {"manos": hands_check(clip_paths, win, workdir), "cortes": cut_check(clip_paths, win)}
    report["alertas"] = (report["manos"].get("alertas") or []) + (report["cortes"].get("alertas") or [])
    sheet = contact_sheet(video, os.path.join(workdir, "qa_hoja.jpg"))
    path = os.path.join(workdir, "qa.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False)
    return [(sheet, "image/jpeg"), (path, "application/json")]
