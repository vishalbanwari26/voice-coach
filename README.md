# Voice Coach

Real-time spoken practice that runs on your phone, with no server:

- **Interview mode**: an interviewer for any round (recruiter screen, hiring manager, technical deep dive, AI/ML, system design, behavioural, verbal coding, founder). Give it the company, role, job description and your CV. It asks one question at a time, follows up when an answer is vague or hides behind "we", and checks that your claims add up.
- **German mode**: Lena, a tutor at your level (A1 to B2), in a situation you pick: small talk at work, explaining your projects, a job interview, Bürgeramt, doctor, landlord. She corrects you after each answer or only at the end, and keeps practising the mistakes you repeat.

It works like a phone call: the mic stays open and you can **talk over the AI to interrupt it**. At the end you get a report: scores, answer-by-answer feedback and the three things to fix first (interview), or every correction, new words and a level estimate (German).

## How it works

```
phone browser ──audio both ways──▶ Gemini Live API   the conversation, interruptions
      │
      ├──each of your answers──▶ Whisper on Groq     an accurate transcript, filler words kept
      └──transcript at the end──▶ gpt-oss-120b on Groq   the report
```

Everything runs in the browser. Your API keys, settings, past sessions and German mistakes are stored only on the device (localStorage) and are sent only to Google and Groq.

## Install on Android

1. Open the hosted page in Chrome.
2. Settings: paste your Gemini and Groq API keys, add your name and a line about yourself for the tutor, then Save.
3. Chrome menu → "Add to Home screen" (or "Install app"). It then opens full screen from its own icon.

Use earphones for the cleanest interruptions. Without them, tick "Speaker mode" so the AI does not hear itself (you then can't interrupt).

## Run it on a laptop

```bash
python3 -m http.server 8765 --directory docs
```

Then open http://localhost:8765 in Chrome. The microphone only works on `localhost` or an https address.

## Notes

- Long sessions keep going: context compression is on, and the app reconnects by itself when Google recycles the connection (about every 10 minutes).
- "Pause before it replies" is how long you can stop mid-answer before the AI responds. Raise it if it cuts you off while you think.
- Pace and filler counts are estimates. With Whisper on they come from Whisper's timings; otherwise from the live transcript, which drops most fillers.
- Models can be changed in Settings.
