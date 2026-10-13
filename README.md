# MAX — shaxsiy yordamchi (Windows)

Tony Stark'ning J.A.R.V.I.S.'iga o'xshash, ingliz tilida emotsiya bilan gapiradigan yordamchi.
Hech narsa o'rnatish shart emas: Windows'dagi PowerShell va Chrome (yoki Edge) yetarli.
Hamma xizmatlar **bepul**.

## Ishga tushirish

1. **`Max.bat`** ni ikki marta bosing. MAX oynasi ochiladi.
2. Birinchi marta mikrofon so'raladi — **Allow / Разрешить** ni bosing.
3. Kompyuter ovozi o'chiq (mute) bo'lmasin — aks holda Max'ni eshitmaysiz.
4. Max'ning "aqli" uchun bepul kalit qo'shing (pastga qarang). Kalitsiz ham oddiy buyruqlarni bajaradi.

Oynani yopsangiz, Max ham to'xtaydi. Xatolarni ko'rish uchun `Max-debug.bat` dan foydalaning.

- `Desktop-shortcut.bat` — ish stolida MAX belgisini yaratadi.
- `Autostart-on.bat` / `Autostart-off.bat` — Windows yonganda Max'ni avtomatik ishga tushirish / o'chirish.

## Bepul AI kalit (bittasi yetarli)

| Provayder | Qayerdan olinadi | Izoh |
|---|---|---|
| **Groq** (tavsiya) | https://console.groq.com/keys | Juda tez, bepul |
| Google Gemini | https://aistudio.google.com/apikey | Bepul |
| OpenRouter | https://openrouter.ai/keys | `:free` modellar |
| Ollama | https://ollama.com | Kompyuterda ishlaydi, kalit kerak emas |

Kalitni Max oynasidagi ⚙ (Settings) → **AI BRAIN** ga qo'ying → **SAVE & TEST BRAIN**.
Kalitlar faqat sizning kompyuteringizda, `data\config.json` faylida saqlanadi.

## Qanday gaplashiladi

- **"Max, ..."** deb gapiring (yoki **Space** tugmasi / sferani bosing), yoki pastdagi qatorga yozing.
- Max javob bergach, 7 soniya davomida "Max" demasdan davom ettirish mumkin.
- **Esc** — Max'ni to'xtatish, **/** — yozish, **Ctrl+,** — sozlamalar.

Misollar:
- "Max, open Telegram" · "close Chrome" · "play Imagine Dragons on YouTube"
- "What's the weather?" · "Any tech news?" · "Who is Elon Musk?"
- "Volume to 40" · "mute" · "next song" · "take a screenshot" · "lock the PC"
- "Set a timer for 5 minutes" · "Remind me at 18:30 to call mom" · "Note that..."
- "Find my resume" · "Open downloads" · "How's my PC doing?"
- "Shut down the computer" — Max avval "aminmisiz?" deb so'raydi.

## Max nimalarni qila oladi (va nimalarni qilmaydi)

Qila oladi: ilovalarni ochish/yopish (Start menyusidagi hammasi), sayt va qidiruv, YouTube'da qo'shiq qo'yish,
papka va hujjatlarni ochish, fayl qidirish, ovoz/yorqinlik/media boshqaruvi, skrinshot, kompyuterni qulflash,
o'chirish/qayta yoqish (tasdiq bilan), ob-havo, yangiliklar (BBC), Wikipedia, kalkulyator, taymer va eslatmalar,
eslatmalar daftari, clipboard.

Qilmaydi (xavfsizlik uchun): dastur/skript fayllarini ishga tushirish, fayllarni o'chirish, parollar, to'lovlar,
tizim sozlamalarini o'zgartirish.

## Xotira

Max har safar o'qiydi:
- **`data\about_me.md`** — o'zingiz haqingizda yozing (sozlamalardagi "About me" maydoni ham shu).
- O'zi suhbatda o'rgangan faktlar — `data\max_memory.json` (sozlamalarda ko'rish/o'chirish mumkin, yoki "Max, forget that...").
- **Claude bilan bo'lgan xotiralaringiz** — `%USERPROFILE%\.claude` ichidagi Claude xotira fayllari va
  Claude Code'dagi so'nggi suhbatlaringizdagi so'rovlaringiz. Buni sozlamalarda o'chirib qo'yish mumkin.
- Oxirgi suhbatlar tarixi — `data\history.json`.

Eslatma: Max javob yozishi uchun bu xotira tanlangan AI provayderga (masalan, Groq) yuboriladi.

## Texnik

- `server\server.ps1` — mahalliy server (http://localhost:8765), `server\handlers.ps1` — buyruqlar, AI, xotira.
- `server\MaxNative.cs` — Microsoft Edge neyron ovozlari (bepul), ovoz balandligi, media tugmalar.
- `web\` — interfeys: `orb.js` (zarrachali reaktor animatsiyasi), `app.js` (ovoz, mikrofon, HUD), `brain.js` (shaxsiyat va AI).
- Max faqat bitta ovozda gapiradi: **Brian** (Microsoft neyron ovozi). Ovoz xizmati javob bermasa, boshqa ovozga
  o'tmaydi — javob ekranda matn bo'lib chiqadi.
- Tezlik: AI ~0,5 s, ovoz ~1–1,5 s (yangi gap uchun xizmatning o'zi shuncha vaqt oladi). Javob bo'laklarga bo'lib
  o'qiladi: birinchi qisqa bo'lak darhol, qolganlari u o'qilayotganda tayyorlanadi.
- Agar Max "qotib" qolsa: oynani yoping va `Max.bat` ni qayta oching — qotib qolgan eski nusxa avtomatik almashtiriladi.
