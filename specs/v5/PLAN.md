# v5 corto (formato cuadrado, Veo 3.1 Fast + referencias)

1. Lanzar las 5 tomas de starts.sql vía mcp__Supabase__execute_sql, una por llamada, ~20 s entre cada una (límite ~4 por minuto). Revisar net._http_response de cada id: ok -> generation_id. Si sale quota, esperar y reintentar más tarde (NO usar lite).
2. Esperar ~3 min, luego ugc_call veo_status por cada generation_id hasta "listo".
3. review.yml (gh api dispatch, tag v5c) con las 5 URLs: revisar cara, encuadre (cx), silencios (tiempos de cada frase).
4. Armar spec con "frame":"square" (studio/render.py ya lo soporta, video en y=420..1500), ~28 s:
   - T1 mall gancho ("Mire bien esta cara...") + caveat "comenta UGC" pequeño dentro del cuadro.
   - T2 cuarto hasta "yo no existo" -> corte a gráfico oscuro (mismo clip, scrim 0.86, fotos flotando, "CREADA CON IA", sfx impact) mientras dice "Me hicieron con IA".
   - Inserto labial (laura_v4_t3_v_1791829668846.mp4, 0.2-2.0) "UGC".
   - T3 cama "RESEÑAS".
   - T4 carro "Y le puedo hacer videos a su negocio" -> gráfico oscuro de 3 pasos con la voz de T4 ("Usted escoge...").
   - Inserto plato (laura_v4_t7_v_1791829668901.mp4, 0.3-2.0) "ASÍ SE VE TU MARCA".
   - T5 mall cierre "comente UGC" + logo animado (bucle con T1).
   - Música: musica/ugc-v4-arco-1791829033784.mp3, music_volume 0.24, end_dark, sin voice_model.
   - Textos: en el cuadro, manuscrito (caveat) al lado de la cara como la referencia; palabras clave en amarillo.
5. Insertar job + render.yml (patrón de scratchpad/final/job.sql), review, rechazar la aprobación interna si es prueba, mandar link a Cobo en español sin guiones largos.
Costo esperado: 5 tomas x 0,80 USD = 4 USD (~COP 16.000).
