# AnalytiQ Studio

Sala de edición automática de AnalytiQ Core. Convierte una especificación JSON en piezas de marca listas para redes:

- **Reel** 1080x1920: textos animados + clip de Gemini (Veo) al inicio + música de Lyria.
- **Carrusel / post** 1080x1350 en PNG.

## Cómo funciona

1. Supabase (`analytiq-studio`) crea un trabajo en `analytiq_content_jobs`, pide el clip y la música a Gemini.
2. Cuando los insumos están listos, dispara el workflow **Render pieza** con el `job_id`.
3. El workflow renderiza con `studio/`, sube los archivos al bucket `analytiq-media` y deja la pieza pendiente en la Torre de control.

## Prueba local

```bash
pip install -r requirements.txt   # y ffmpeg instalado
python -m studio.pipeline --spec specs/carrusel_3_numeros.json --out salida/
python -m studio.pipeline --spec specs/reel_cuanto_te_queda.json --out salida/ --clip clip.mp4 --music musica.mp3
```

## Secretos

- GitHub → Settings → Secrets → Actions: `STUDIO_SECRET` (el mismo valor que `analytiq_studio_secret` en el Vault de Supabase).
- Supabase Vault: `analytiq_github_token` (token de GitHub con permiso de Actions sobre este repo).

Marca: Azul Profundo #0A2E4A de fondo, Naranja Core #E66521 solo como acento (máximo dos elementos), Azul Dato #4BA0C7, Montserrat (licencia OFL en `fonts/`).
