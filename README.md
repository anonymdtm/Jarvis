# Jarvis-Server – in 5 Minuten, kostenlos

Damit niemand in der Jarvis-App einen Schlüssel eintragen muss, liegt **dein** OpenRouter-Schlüssel nur hier auf dem
Server. Die App fragt den Server, und der Server fragt die kostenlosen KI-Modelle (NVIDIA Nemotron, Google Gemma, beim
Programmieren Cohere North Mini Code, bei „Was ist das?“ ein Modell, das Bilder ansehen kann).

## So geht's

1. Öffne diesen Link: **https://render.com/deploy?repo=https://github.com/anonymdtm/Jarvis/tree/proxy**
2. Melde dich bei Render an (am einfachsten mit „GitHub“). Kostenlos, keine Kreditkarte.
3. Render zeigt „jarvis-warpline“ und fragt nach zwei Werten:
   - **OPENROUTER_API_KEY** → dein Schlüssel von openrouter.ai (Keys → Create Key)
   - **APP_TOKEN** → das Zufallswort, das Claude dir im Chat gegeben hat
4. **Deploy Blueprint** / **Apply** tippen und 2–3 Minuten warten.
5. Oben steht dann die Adresse, z. B. `https://jarvis-warpline.onrender.com`. Zum Prüfen `…/healthz` öffnen → `{"ok":true}`.
6. Schick Claude **nur die Adresse**. Den Schlüssel bitte nie weitergeben.

## Gut zu wissen

- **Kosten: 0 €.** Die Gratis-Modelle kosten nichts, Render Free kostet nichts. Abgebucht wird nie etwas von selbst.
- **Grenze:** Ohne gekauftes Guthaben erlaubt OpenRouter 50 Gratis-Anfragen am Tag – für **alle Nutzer zusammen**. Wer
  einmal freiwillig 10 $ Guthaben kauft, bekommt 1000 am Tag. Die 10 $ werden von Gratis-Modellen nicht verbraucht. Danach
  in Render unter Environment `LIMIT_ALL_PER_DAY=950` setzen.
- **Wach bleiben:** Render Free schläft nach 15 Minuten ohne Anfrage ein. Der Server ruft sich deshalb alle 10 Minuten
  selbst auf. Abschalten geht mit `KEEP_AWAKE=0`.
- **Schutz:** Limits pro Gerät, pro IP-Adresse und für alle zusammen, Eingabeprüfung, der Schlüssel steht nur in Render.
  Details: [ANLEITUNG.md](ANLEITUNG.md).
- **Schnell antworten:** Hängt ein Modell, fragt der Server nach ein paar Sekunden zusätzlich das nächste – wer zuerst
  schreibt, gewinnt. Wartezeiten: `HEDGE_VISION_MS` (Bilder, 6000), `HEDGE_CHAT_MS` (8000), `HEDGE_CODE_MS` (12000).
- **Neu bauen:** Render baut bei jedem Push auf den Zweig `proxy` selbst neu (GitHub-Verbindung für das Repo ist eingerichtet).
- **Test auf dem eigenen Rechner:** `npm test`.
