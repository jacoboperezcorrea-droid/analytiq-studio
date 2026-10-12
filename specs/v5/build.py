import json
SP=1.05
V="https://nhvtrxxaggusvlimavdn.supabase.co/storage/v1/object/public/analytiq-media/ugc/videos/"
M="https://nhvtrxxaggusvlimavdn.supabase.co/storage/v1/object/public/analytiq-media/ugc/modelos/laura/"
clips=[V+"laura_v5_t1_mall_1791835738493.mp4",V+"laura_v5_t2_cuarto_1791835509186.mp4",V+"laura_v4_t3_v_1791829668846.mp4",
       V+"laura_v5_t3_cama_1791835509188.mp4",V+"laura_v5_t4_carro_1791835509311.mp4",V+"laura_v4_t7_v_1791829668901.mp4",V+"laura_v5_t5_mall_1791835509262.mp4"]
def cap(lines,at,y,x="C",size=90,font="anton",until=None,hold=True):
    d={"t":"cap","font":font,"lines":lines,"size":size,"x":x,"y":y,"at":round(at/SP,2),"hold":hold}
    if until is not None: d["until"]=round(until/SP,2); d.pop("hold")
    return d
def sc(clip,s,e,items,scrim=0,zoom=0.04,punch=1.0,cx=0.5,**kw):
    d={"dur":round((e-s)/SP,2),"brand":False,"bg":{"clip":clip,"start":s,"scrim":scrim,"zoom":zoom,"punch":punch,"cx":cx},"items":items}
    d.update(kw); return d
W,Y="white","yellow"
scenes=[
 sc(0,0.0,2.2,[cap([["comente",W],["UGC",Y]],0,1240,"L",140,"caveat")],zoom=0.06),
 sc(1,0.35,5.8,[cap([["¿usted cree",W],["que me conoce?",W]],0.05,1310,"C",124,"caveat",until=1.7),
                cap([["le tengo que",W],["confesar algo...",Y]],2.05,1310,"C",124,"caveat",until=4.0),
                cap([["yo no existo",Y]],4.5,1300,"C",175,"caveat")],zoom=0.07,sfx=["riser"]),
 sc(1,6.0,8.0,[{"t":"phone","src":M+"v3_mall_1791807312746_1.jpg","style":"photo","w":230,"x":90,"y":560,"at":0.05,"hold":True},
               {"t":"phone","src":M+"humano_test_1791775731018_1.jpg","style":"photo","w":270,"x":405,"y":500,"at":0.2,"hold":True},
               {"t":"phone","src":M+"v3_carro_1791807312835_1.jpg","style":"photo","w":230,"x":760,"y":580,"at":0.35,"hold":True},
               cap([["CREADA",W],["CON IA",Y]],0.45,1120,"C",150)],scrim=0.86,zoom=0.02,sfx=["impact"]),
 sc(2,0.2,1.7,[cap([["UGC",Y]],0.02,1050,"C",170)],zoom=0.05,whoosh=True),
 sc(3,0.0,4.75,[cap([["RESEÑAS",W]],0.25,1050,"C",150,until=2.3),cap([["CONTENIDO",W],["UGC",Y]],2.3,1000,"C",120)],zoom=0.04,whoosh=True),
 sc(3,5.55,7.5,[cap([["y nadie nota",W],["la diferencia",Y]],0.05,1310,"C",128,"caveat")],zoom=0.05,punch=1.1),
 sc(4,0.0,2.9,[cap([["y puedo hacerle",W],["videos a su negocio",Y]],0.3,1310,"C",112,"caveat")],cx=0.35,zoom=0.04,whoosh=True),
 sc(4,3.4,7.7,[{"t":"phone","src":M+"v3_mall_1791807312746_1.jpg","style":"photo","w":170,"x":180,"y":500,"at":0.05,"hold":True},
               {"t":"phone","src":M+"humano_test_1791775383709_3.jpg","style":"photo","w":170,"x":455,"y":480,"at":0.15,"hold":True},
               {"t":"phone","src":M+"humano_test_1791775731018_1.jpg","style":"photo","w":170,"x":730,"y":500,"at":0.25,"hold":True},
               cap([["1. ESCOGE LA MODELO",W]],0.15,800,"C",80),
               cap([["2. MANDA EL PRODUCTO",W]],1.45,920,"C",80),
               cap([["3. NOSOTROS HACEMOS EL RESTO",W]],2.6,1040,"C",74),
               cap([["LISTOS PARA PUBLICAR",Y]],3.5,1220,"C",92)],scrim=0.9,zoom=0.02,cx=0.35,whoosh=True),
 sc(5,0.3,1.8,[cap([["ASÍ SE VE",W],["TU MARCA",Y]],0.02,1100,"C",104)],zoom=0.05,whoosh=True),
 sc(6,0.55,4.5,[cap([["comente",W],["UGC",Y]],0,1240,"L",140,"caveat")],zoom=0.05,whoosh=True),
 sc(6,5.25,7.1,[cap([["comente",W],["UGC",Y]],0,1240,"L",140,"caveat"),{"t":"logo","w":440,"y":560,"at":0.25,"hold":True}],zoom=0.04),
]
spec={"kind":"reel","title":"AnalytiQ UGC v5 (Usted cree que me conoce)","frame":"square","voice":True,"speed":SP,"brand":False,"end_dark":True,
      "cover_at":0.3,"music_volume":0.22,"clips":[{"url":u} for u in clips],"scenes":scenes}
json.dump(spec,open("spec.json","w"),ensure_ascii=False)
print(round(sum(s["dur"] for s in scenes),2),len(scenes))
