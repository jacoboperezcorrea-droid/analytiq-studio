"""Montaje final: clip de Gemini (opcional) + animacion + musica (opcional)."""
import json, subprocess

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    dur = float(j["format"]["duration"])
    has_audio = any(s.get("codec_type") == "audio" for s in j.get("streams", []))
    return dur, has_audio

def compose(anim, out, clip=None, music=None, clip_volume=0.6, music_volume=0.35, xfade=0.4, voice=None):
    """voice: pista de voz ya alineada a la animacion (reels de modelos UGC). Si hay voz, la musica baja."""
    anim_dur, _ = probe(anim)
    inputs = ["-i", anim]
    fc = []
    if voice:
        inputs += ["-i", voice]
        fc.append("[0:v]fps=30,setsar=1,format=yuv420p[v]")
        total = anim_dur
        fc.append(f"[1:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:{total:.3f}[ca]")
        music_volume = min(music_volume, 0.12)
    elif clip:
        clip_dur, clip_audio = probe(clip)
        inputs += ["-i", clip]
        fc.append("[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p[cv]")
        fc.append("[0:v]fps=30,setsar=1,format=yuv420p[av]")
        off = max(0.1, clip_dur - xfade)
        fc.append(f"[cv][av]xfade=transition=fade:duration={xfade}:offset={off:.3f}[v]")
        total = off + anim_dur
        if clip_audio:
            fc.append(f"[1:a]volume={clip_volume},afade=t=out:st={max(0, clip_dur - 0.6):.3f}:d=0.6,apad[ca]")
        else:
            fc.append(f"anullsrc=r=44100:cl=stereo,atrim=0:{total:.3f}[ca]")
    else:
        fc.append("[0:v]fps=30,setsar=1,format=yuv420p[v]")
        total = anim_dur
        fc.append(f"anullsrc=r=44100:cl=stereo,atrim=0:{total:.3f}[ca]")
    if music:
        mi = len(inputs) // 2
        inputs = inputs[:] + ["-stream_loop", "-1", "-i", music]
        fc.append(f"[{mi}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,volume={music_volume},"
                  f"afade=t=in:st=0:d=0.5,afade=t=out:st={max(0, total - 1.5):.3f}:d=1.5[ma]")
        fc.append("[ca][ma]amix=inputs=2:duration=longest:normalize=0[a]")
    else:
        fc.append("[ca]anull[a]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error"] + inputs + [
        "-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-preset", "medium",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    return total
