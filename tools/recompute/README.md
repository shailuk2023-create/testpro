# Leaderboard Coins — Automatic Recalculation (FREE, GitHub Actions)

## Ye kya hai?

TESTPRO app me har user ke coins uske apne phone par calculate hote hain — jab wo naya version kholta hai, tabhi uska total update hota hai. Isliye kisi user ka total purana (stale) dikh sakta hai — jaise vk ka total 8035 dikh raha tha, jabki sahi total ~620–640 hona chahiye tha.

Ye setup us problem ko **server-side, automatic** solve karta hai:
- GitHub Actions (GitHub ka free tier — **koi paisa nahi lagta, Blaze/paid plan ki zaroorat nahi**) har 1 ghante me khud chal kar **sabhi users ke coin totals dobara calculate** karta hai aur Firebase me update kar deta hai.
- Kisi user ko app kholne ki zaroorat nahi — totals apne aap sahi rehte hain.

**Important:** Neeche ke Step 1 aur Step 2 **aapko khud karne hain** — service account key aur GitHub secret sirf aap bana sakte hain, assistant aapke Firebase console ya GitHub settings me nahi ja sakta.

---

## Step 1 — Firebase service account key download karein

1. [Firebase console](https://console.firebase.google.com/) kholein aur **testpro777** project chunein.
2. Left side gear icon (⚙️) → **Project settings** par click karein.
3. Upar **Service accounts** tab par click karein.
4. **"Generate new private key"** button par click karein → confirm karein.
5. Ek **JSON file** download hogi — use apne phone/computer par safe jagah save karke rakhein.

> ⚠️ **Ye file ek secret key hai — ise kabhi kisi ko share mat karein, kisi public jagah (WhatsApp group, GitHub, screenshot) par mat daalein.** Sirf agle step me GitHub secret me paste karni hai.

---

## Step 2 — GitHub me secret daalein

1. GitHub par **shailuk2023-create/testpro** repo kholein.
2. Upar **Settings** tab → left menu me **Secrets and variables** → **Actions** par click karein.
3. **"New repository secret"** button par click karein.
4. **Name** me bilkul ye likhein (ek akshar bhi galat nahi hona chahiye):
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON
   ```
5. **Value** me Step 1 me download ki hui JSON file ko Notepad/text editor me kholkar **uska POORA content** copy-paste karein (pehle `{` se aakhiri `}` tak, kuch bhi chhodein bina).
6. **Add secret** par click karein.

---

## Step 3 — Abhi turant ek baar chalayein (sabke totals abhi update karein)

1. GitHub repo me upar **Actions** tab par click karein.
2. Left side workflow list me **"Recompute leaderboard coins"** chunein.
3. Right side **"Run workflow"** button → **Run workflow** par click karein.
4. 1–2 minute me workflow poora hoga (green tick ✅ aayega).
5. App me leaderboard check karein — **vk ka total 8035 se girkar ~620–640** ke aas-paas aana chahiye.

---

## Step 4 — Automatic: aage kuch karne ki zaroorat nahi

- Iske baad ye workflow **har 1 ghante me apne aap chalega** — sabke totals khud-ba-khud sahi rehte hain.
- Har run sirf ~30 second ka hota hai (npm caching ki wajah se), to mahine bhar me bhi GitHub ke free minutes (2,000/month) ke andar rehta hai.
- Aapko dobara kuch nahi karna. Kabhi manually chalana ho to Step 3 dobara karein.

---

## Troubleshooting (agar workflow fail ho jaye)

| Error / lakshan | Kya karein |
|---|---|
| `secret not found` ya secret se related error | Step 2 dobara check karein — secret ka **name bilkul `FIREBASE_SERVICE_ACCOUNT_JSON`** hona chahiye, ek space bhi extra nahi. |
| Firebase permission error | Service account key galat ya expire ho gayi hai — Step 1 se **nayi key generate** karein aur Step 2 me secret **update** karein (secret par click karke naya value daalein). |
| Workflow chala par totals nahi badle | Actions tab me us run ka log kholein — aakhiri lines me likha hoga kitne users update hue. Agar "0 users" likha ho to assistant ko batayein. |

---

## Files (technical reference)

- `tools/recompute/recompute.js` — coin calculation ka logic (v69 formula, bilkul wahi jo app me hai).
- `tools/recompute/run.js` — Firebase se sab users padhta hai, totals recalculate karke wapas likhta hai.
- `tools/recompute/package.json` — zaroori library (`firebase-admin`).
- `.github/workflows/recompute-coins.yml` — GitHub Actions workflow: har 1 ghante + manual run.
